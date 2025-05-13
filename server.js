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

// Use dynamic import for node-fetch
let fetch;
(async () => {
  fetch = (await import('node-fetch')).default;
})();

dotenv.config();

const app = express();
app.set('trust proxy', 1); // Trust Render's proxy for correct IP
const port = process.env.PORT || 3000;

// Middleware
app.use(express.static(__dirname));
app.use(express.json());
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE'],
  credentials: true
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000,
  message: 'Too many requests from this IP, please try again later.'
});
app.use(limiter);

// Session setup
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: false,
  saveUninitialized: true,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'strict',
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// File upload
const upload = multer({ limits: { fileSize: 8 * 1024 * 1024 } });

// Webhook storage and caches
const webhooks = [];
const webhookCache = new Map();    // Cache validated webhooks
const lastAttempts = new Map();    // Cooldown tracking per URL

// Fully proofed webhook validation
async function validateWebhook(url) {
  const now = Date.now();
  const cooldownMs = 5000;

  if (lastAttempts.has(url) && now - lastAttempts.get(url) < cooldownMs) {
    throw new Error('Too many attempts. Please wait a few seconds and try again.');
  }
  lastAttempts.set(url, now);

  if (webhookCache.has(url)) {
    return webhookCache.get(url);
  }

  try {
    if (!fetch) throw new Error('Fetch module not loaded');
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000
    });

    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after') || 'unknown';
      throw new Error(`Rate limited by Discord. Retry after ${retryAfter} ms.`);
    }
    if (!response.ok) {
      throw new Error(`Invalid webhook URL: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const webhookData = {
      id: data.id,
      name: data.name || 'Unnamed Webhook',
      avatar: data.avatar
        ? `https://cdn.discordapp.com/avatars/${data.id}/${data.avatar}.png`
        : 'https://cdn.discordapp.com/embed/avatars/0.png',
      channelId: data.channel_id,
      url
    };

    webhookCache.set(url, webhookData);
    return webhookData;
  } catch (error) {
    console.error('Webhook validation failed:', error.message);
    throw new Error(`Webhook validation failed: ${error.message}`);
  }
}

// Add webhook endpoint with backoff and cache
app.post('/add-webhook', async (req, res) => {
  const { url } = req.body;
  if (!url || !url.startsWith('https://discord.com/api/webhooks/')) {
    console.log('Invalid webhook URL received');
    return res.status(400).json({ error: 'Invalid webhook URL format' });
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
    console.error(`Error adding webhook: ${error.message}`);
    res.status(429).json({ error: error.message });
  }
});

// Send message endpoint
app.post('/send-message', upload.single('file'), async (req, res) => {
  const { webhookId, content } = req.body;
  const file = req.file;
  if (!webhookId) return res.status(400).json({ error: 'Webhook ID is required' });

  const webhook = webhooks.find(w => w.id === webhookId);
  if (!webhook) return res.status(404).json({ error: 'Webhook not found' });
  if (!content && !file) return res.status(400).json({ error: 'Content or file is required' });

  try {
    if (!fetch) throw new Error('Fetch module not loaded');
    const formData = new FormData();
    if (content) formData.append('content', content);
    if (file) {
      formData.append('file', file.buffer, { filename: file.originalname, contentType: file.mimetype });
    }

    const response = await fetch(webhook.url, { method: 'POST', body: formData, headers: formData.getHeaders(), timeout: 10000 });
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

// Delete webhook
app.delete('/webhook/:id', (req, res) => {
  const index = webhooks.findIndex(w => w.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Webhook not found' });
  webhooks.splice(index, 1);
  console.log(`Webhook deleted: ${req.params.id}`);
  res.json({ success: true });
});

// Fetch messages endpoint
app.get('/messages/:channelId', async (req, res) => {
  try {
    const channel = await client.channels.fetch(req.params.channelId, { force: true });
    if (!channel || !channel.isTextBased()) return res.status(400).json({ error: 'Invalid channel' });

    const botMember = channel.guild.members.me;
    const permissions = channel.permissionsFor(botMember);
    if (!permissions.has([PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory])) {
      return res.status(403).json({ error: 'Missing permissions' });
    }

    const messages = await channel.messages.fetch({ limit: 50 });
    const formatted = messages.map(msg => ({
      id: msg.id,
      content: msg.content,
      author: { username: msg.author.username, avatar: msg.author.avatarURL() || 'https://cdn.discordapp.com/embed/avatars/0.png' },
      timestamp: msg.createdAt.toISOString(),
      embeds: msg.embeds.map(e => ({ title: e.title, description: e.description, fields: e.fields.map(f => ({ name: f.name, value: f.value })), thumbnail: e.thumbnail?.url, image: e.image?.url })),
      attachments: msg.attachments.map(a => ({ url: a.url, filename: a.name, contentType: a.contentType }))
    }));

    console.log(`Fetched ${formatted.length} messages for channel ${req.params.channelId}`);
    res.json(formatted);
  } catch (error) {
    console.error(`Error fetching messages for channel ${req.params.channelId}: ${error.message}`);
    res.status(500).json({ error: `Failed to fetch messages: ${error.message}` });
  }
});

// Discord client login
client.once('ready', () => console.log(`Logged in as ${client.user.tag}`));
client.login(process.env.BOT_TOKEN).catch(err => { console.error(`Login failed: ${err.message}`); process.exit(1); });

// Server start
if (process.env.NODE_ENV === 'production' && process.env.USE_LOCAL_HTTPS === 'true') {
  const privateKey = fs.readFileSync(process.env.SSL_KEY_PATH, 'utf8');
  const certificate = fs.readFileSync(process.env.SSL_CERT_PATH, 'utf8');
  https.createServer({ key: privateKey, cert: certificate }, app)
    .listen(port, '0.0.0.0', () => console.log(`HTTPS Server running on port ${port}`));
} else {
  app.listen(port, '0.0.0.0', () => console.log(`Server running on port ${port}`));
}
