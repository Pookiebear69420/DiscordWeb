const express = require('express');
const cors = require('cors');
const { Client, GatewayIntentBits, PermissionsBitField } = require('discord.js');
const session = require('express-session');
const multer = require('multer');
const dotenv = require('dotenv');
const FormData = require('form-data');
const rateLimit = require('express-rate-limit');
const https = require('https');
const fs = require('fs');
const path = require('path');
// Add Redis dependencies
const Redis = require('redis');
const RedisStore = require('connect-redis').default;

// Use dynamic import for node-fetch
let fetch;
(async () => {
  fetch = (await import('node-fetch')).default;
})();

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Initialize Redis client
const redisClient = Redis.createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379', // Use the Render Redis URL from environment variable
});
redisClient.on('error', (err) => console.error('Redis Client Error:', err));
redisClient.connect().catch(err => {
  console.error('Failed to connect to Redis:', err);
});

// Serve static files (e.g., index.html, DCN.mp3) from the root directory
app.use(express.static(__dirname));

// Serve index.html at the root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Rate limiting middleware
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});
app.use(limiter);

// CORS configuration (allow all origins since no frontend domain yet)
app.use(cors({
  origin: '*', // Allow all origins for now; update to specific domains when you have a frontend
  methods: ['GET', 'POST', 'DELETE'],
  credentials: true
}));

app.use(express.json());

// Configure session with RedisStore
app.use(session({
  store: new RedisStore({
    client: redisClient,
    prefix: 'session:', // Optional: prefix for session keys in Redis
  }),
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: false,
  saveUninitialized: true,
  cookie: { 
    secure: process.env.NODE_ENV === 'production', // Secure cookies in production
    httpOnly: true,
    sameSite: 'strict',
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const upload = multer({
  limits: { fileSize: 8 * 1024 * 1024 } // 8MB limit
});

const webhooks = [];

async function validateWebhook(url) {
  try {
    if (!fetch) throw new Error('Fetch module not loaded');
    const response = await fetch(url, { 
      method: 'GET', 
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000 // Add timeout to prevent hanging
    });
    if (!response.ok) {
      throw new Error(`Invalid webhook URL: ${response.statusText}`);
    }
    const data = await response.json();
    return {
      id: data.id,
      name: data.name || 'Unnamed Webhook',
      avatar: data.avatar ? `https://cdn.discordapp.com/avatars/${data.id}/${data.avatar}.png` : 'https://cdn.discordapp.com/embed/avatars/0.png',
      channelId: data.channel_id,
      url
    };
  } catch (error) {
    throw new Error(`Webhook validation failed: ${error.message}`);
  }
}

app.post('/add-webhook', async (req, res) => {
  const { url } = req.body;

  if (!url || !url.startsWith('https://discord.com/api/webhooks/')) {
    console.log('Invalid webhook URL received');
    return res.status(400).json({ error: 'Invalid webhook URL' });
  }

  try {
    const webhook = await validateWebhook(url);

    if (webhooks.some(w => w.url === url)) {
      console.log(`Duplicate webhook URL: ${url}`);
      return res.status(400).json({ error: 'Webhook already exists' });
    }

    webhooks.push(webhook);
    console.log(`Webhook added: ${webhook.name} (${webhook.id})`);
    res.json({
      webhook,
      privacyNotice: 'Webhook URLs are stored locally and sent to this server for processing. Ensure you trust the server operator.'
    });
  } catch (error) {
    console.log(`Error adding webhook: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

app.post('/send-message', upload.single('file'), async (req, res) => {
  const { webhookId, content } = req.body;
  const file = req.file;

  if (!webhookId) {
    console.log('No webhook ID provided');
    return res.status(400).json({ error: 'Webhook ID is required' });
  }

  const webhook = webhooks.find(w => w.id === webhookId);
  if (!webhook) {
    console.log(`Webhook not found: ${webhookId}`);
    return res.status(404).json({ error: 'Webhook not found' });
  }

  if (!content && !file) {
    console.log('No content or file provided');
    return res.status(400).json({ error: 'Content or file is required' });
  }

  try {
    if (!fetch) throw new Error('Fetch module not loaded');
    const formData = new FormData();
    if (content) {
      formData.append('content', content);
    }
    if (file) {
      formData.append('file', file.buffer, {
        filename: file.originalname,
        contentType: file.mimetype
      });
    }

    const response = await fetch(webhook.url, {
      method: 'POST',
      body: formData,
      headers: formData.getHeaders(),
      timeout: 10000 // Add timeout for message sending
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to send message to Discord: ${response.status} - ${errorText}`);
    }

    console.log(`Message sent successfully to webhook: ${webhookId}`);
    res.json({ success: true });
  } catch (error) {
    console.error(`Error sending message: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

app.delete('/webhook/:id', (req, res) => {
  const { id } = req.params;
  const index = webhooks.findIndex(w => w.id === id);

  if (index === -1) {
    console.log(`Webhook not found for deletion: ${id}`);
    return res.status(404).json({ error: 'Webhook not found' });
  }

  webhooks.splice(index, 1);
  console.log(`Webhook deleted: ${id}`);
  res.json({ success: true });
});

app.get('/messages/:channelId', async (req, res) => {
  const { channelId } = req.params;

  try {
    const channel = await client.channels.fetch(channelId, { force: true });
    if (!channel) {
      console.log(`Channel not found: ${channelId}`);
      return res.status(404).json({ error: 'Channel not found' });
    }

    if (!channel.isTextBased()) {
      console.log(`Channel is not text-based: ${channelId}`);
      return res.status(400).json({ error: 'Channel is not a text channel' });
    }

    const botMember = channel.guild.members.me;
    const permissions = channel.permissionsFor(botMember);
    if (!permissions.has([PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory])) {
      console.log(`Bot lacks permissions for channel: ${channelId}`);
      return res.status(403).json({ error: 'Bot lacks permissions to view channel or read message history' });
    }

    const messages = await channel.messages.fetch({ limit: 50 });
    const formattedMessages = messages.map(msg => ({
      id: msg.id,
      content: msg.content,
      author: {
        username: msg.author.username,
        avatar: msg.author.avatarURL() || 'https://cdn.discordapp.com/embed/avatars/0.png'
      },
      timestamp: msg.createdAt.toISOString(),
      embeds: msg.embeds.map(embed => ({
        title: embed.title,
        description: embed.description,
        fields: embed.fields.map(field => ({
          name: field.name,
          value: field.value
        })),
        thumbnail: embed.thumbnail ? { url: embed.thumbnail.url } : null,
        image: embed.image ? { url: embed.image.url } : null
      })),
      attachments: msg.attachments.map(attachment => ({
        url: attachment.url,
        filename: attachment.name,
        contentType: attachment.contentType
      }))
    }));

    console.log(`Fetched ${formattedMessages.length} messages for channel: ${channelId}`);
    res.json(formattedMessages);
  } catch (error) {
    console.error(`Error fetching messages for channel ${channelId}: ${error.message}`);
    res.status(500).json({ error: `Failed to fetch messages: ${error.message}` });
  }
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.login(process.env.BOT_TOKEN).catch(error => {
  console.error(`Failed to login to Discord: ${error.message}`);
  process.exit(1);
});

// HTTPS server setup (only for local HTTPS; cloud providers handle SSL)
if (process.env.NODE_ENV === 'production' && process.env.USE_LOCAL_HTTPS === 'true') {
  const privateKey = fs.readFileSync(process.env.SSL_KEY_PATH, 'utf8');
  const certificate = fs.readFileSync(process.env.SSL_CERT_PATH, 'utf8');
  const credentials = { key: privateKey, cert: certificate };
  const httpsServer = https.createServer(credentials, app);
  httpsServer.listen(port, '0.0.0.0', () => {
    console.log(`HTTPS Server running on port ${port}`);
  });
} else {
  // HTTP server for development or cloud providers with built-in SSL
  app.listen(port, '0.0.0.0', () => {
    console.log(`Server running on port ${port}`);
  });
}

// Gracefully close Redis connection on server shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received. Closing Redis connection...');
  await redisClient.quit();
  process.exit(0);
});
