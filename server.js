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
app.set('trust proxy', 1); // Trust proxy for correct client IP
const port = process.env.PORT || 3000;

// Middleware
app.use(express.static(__dirname));
app.use(express.json());
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'DELETE'], credentials: true }));

// Rate limiting
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 1000, message: 'Too many requests from this IP, please try again later.' });
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
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// Discord client
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

// File upload
const upload = multer({ limits: { fileSize: 8 * 1024 * 1024 } });

// Webhook storage and helpers
const webhooks = [];
const webhookCache = new Map();
const lastAttempts = new Map();

// Utility: sleep for ms
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Enhanced webhook validation with capped backoff and caching
async function validateWebhook(url) {
  const cooldownMs = 5000;
  const now = Date.now();
  if (lastAttempts.has(url) && now - lastAttempts.get(url) < cooldownMs) {
    throw new Error('Too many attempts. Please wait a few seconds and try again.');
  }
  lastAttempts.set(url, now);

  if (webhookCache.has(url)) return webhookCache.get(url);

  const maxRetryAfter = 10000; // 10s max wait if Discord rate-limits

  try {
    if (!fetch) throw new Error('Fetch module not loaded');

    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000
    });

    if (response.status === 429) {
      const retryAfter = parseInt(response.headers.get('retry-after')) * 1000 || 0;
      if (retryAfter > maxRetryAfter) {
        throw new Error(`Discord rate limit too long (${retryAfter}ms), aborting.`);
      }
      console.warn(`Rate limited. Waiting ${retryAfter}ms`);
      await sleep(retryAfter);
      return await validateWebhook(url);
    }

    if (!response.ok) {
      throw new Error(`Invalid webhook URL: ${response.statusText}`);
    }

    const data = await response.json();
    const webhook = {
      id: data.id,
      name: data.name || 'Unnamed Webhook',
      avatar: data.avatar ? `https://cdn.discordapp.com/avatars/${data.id}/${data.avatar}.png` : 'https://cdn.discordapp.com/embed/avatars/0.png',
      channelId: data.channel_id,
      url
    };

    webhookCache.set(url, webhook);
    return webhook;
  } catch (err) {
    throw new Error(`Webhook validation failed: ${err.message}`);
  }
}

// Routes
app.post('/add-webhook', async (req, res) => {
  const { url } = req.body;
  if (!url || !url.startsWith('https://discord.com/api/webhooks/')) {
    return res.status(400).json({ error: 'Invalid webhook URL format' });
  }
  try {
    const webhook = await validateWebhook(url);
    if (webhooks.some(w => w.url === url)) {
      return res.status(400).json({ error: 'Webhook already exists' });
    }
    webhooks.push(webhook);
    res.json({ webhook, privacyNotice: 'Webhook URLs are stored locally.' });
  } catch (error) {
    res.status(429).json({ error: error.message });
  }
});

app.post('/send-message', upload.array('files'), async (req, res) => {
  const { webhookId, content } = req.body;
  if (!webhookId) return res.status(400).json({ error: 'Webhook ID is required' });
  const webhook = webhooks.find(w => w.id === webhookId);
  if (!webhook) return res.status(404).json({ error: 'Webhook not found' });
  if (!content && (!req.files || req.files.length === 0)) return res.status(400).json({ error: 'Content or at least one file is required' });

  try {
    const formData = new FormData();
    if (content) formData.append('content', content);

    if (req.files) {
      for (const file of req.files) {
        formData.append('files[]', file.buffer, { filename: file.originalname, contentType: file.mimetype });
      }
    }

    const response = await fetch(webhook.url, {
      method: 'POST',
      body: formData,
      headers: formData.getHeaders(),
      timeout: 10000
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Failed to send message: ${response.status} ${err}`);
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/webhook/:id', (req, res) => {
  const idx = webhooks.findIndex(w => w.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Webhook not found' });
  webhooks.splice(idx, 1);
  res.json({ success: true });
});

app.get('/messages/:channelId', async (req, res) => {
  try {
    const channel = await client.channels.fetch(req.params.channelId, { force: true });
    if (!channel || !channel.isTextBased()) return res.status(400).json({ error: 'Invalid channel' });
    const botMember = channel.guild.members.me;
    const perms = channel.permissionsFor(botMember);
    if (!perms.has([PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory])) {
      return res.status(403).json({ error: 'Missing permissions' });
    }
    const msgs = await channel.messages.fetch({ limit: 50 });
    const formatted = msgs.map(m => ({
      id: m.id,
      content: m.content,
      author: { username: m.author.username, avatar: m.author.avatarURL() || '' },
      timestamp: m.createdAt.toISOString(),
      embeds: m.embeds,
      attachments: m.attachments
    }));
    res.json(formatted);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Discord client ready & login
client.once('ready', () => console.log(`Logged in as ${client.user.tag}`));
client.login(process.env.BOT_TOKEN).catch(err => { console.error(err); process.exit(1); });

// Start server
if (process.env.NODE_ENV === 'production' && process.env.USE_LOCAL_HTTPS === 'true') {
  const key = fs.readFileSync(process.env.SSL_KEY_PATH);
  const cert = fs.readFileSync(process.env.SSL_CERT_PATH);
  https.createServer({ key, cert }, app).listen(port, '0.0.0.0', () => console.log(`HTTPS on ${port}`));
} else {
  app.listen(port, '0.0.0.0', () => console.log(`HTTP on ${port}`));
}
