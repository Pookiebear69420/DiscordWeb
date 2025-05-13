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
app.set('trust proxy', 1); // Trust Render's proxy
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json());
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 1000, message: 'Too many requests from this IP, please try again later.' });
app.use(limiter);
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'DELETE'], credentials: true }));
app.use(session({ secret: process.env.SESSION_SECRET || 'your-secret-key', resave: false, saveUninitialized: true,
  cookie: { secure: process.env.NODE_ENV === 'production', httpOnly: true, sameSite: 'strict', maxAge: 24*60*60*1000 }
}));

const upload = multer({ limits: { fileSize: 8 * 1024 * 1024 } });
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const webhooks = [];
const webhookCache = new Map();
const lastAttempts = new Map();

// Fully-proof webhook validation
async function validateWebhook(url) {
  const now = Date.now(), cooldownMs = 5000;
  if (lastAttempts.has(url) && now - lastAttempts.get(url) < cooldownMs) {
    throw new Error('Too many attempts. Please wait a few seconds and try again.');
  }
  lastAttempts.set(url, now);
  if (webhookCache.has(url)) return webhookCache.get(url);
  try {
    if (!fetch) throw new Error('Fetch module not loaded');
    const response = await fetch(url, { method: 'GET', headers: { 'Content-Type': 'application/json' }, timeout: 5000 });
    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after') || 'unknown';
      throw new Error(`Rate limited by Discord. Retry after ${retryAfter} ms.`);
    }
    if (!response.ok) throw new Error(`Invalid webhook URL: ${response.status} ${response.statusText}`);
    const data = await response.json();
    const webhookData = { id: data.id, name: data.name || 'Unnamed Webhook', avatar: data.avatar ? `https://cdn.discordapp.com/avatars/${data.id}/${data.avatar}.png` : 'https://cdn.discordapp.com/embed/avatars/0.png', channelId: data.channel_id, url };
    webhookCache.set(url, webhookData);
    return webhookData;
  } catch (error) {
    console.error('Webhook validation failed:', error.message);
    throw new Error(`Webhook validation failed: ${error.message}`);
  }
}

// API routes
app.post('/add-webhook', async (req, res) => {
  const { url } = req.body;
  if (!url?.startsWith('https://discord.com/api/webhooks/')) return res.status(400).json({ error: 'Invalid webhook URL format' });
  try {
    const webhook = await validateWebhook(url);
    if (webhooks.some(w => w.url === url)) return res.status(400).json({ error: 'Webhook already exists' });
    webhooks.push(webhook);
    return res.json({ webhook, privacyNotice: 'Webhook URLs are stored locally and sent to this server for processing.' });
  } catch (error) {
    return res.status(429).json({ error: error.message });
  }
});

app.post('/send-message', upload.single('file'), async (req, res) => {
  const { webhookId, content } = req.body, file = req.file;
  if (!webhookId) return res.status(400).json({ error: 'Webhook ID is required' });
  const webhook = webhooks.find(w => w.id === webhookId);
  if (!webhook) return res.status(404).json({ error: 'Webhook not found' });
  if (!content && !file) return res.status(400).json({ error: 'Content or file is required' });
  try {
    if (!fetch) throw new Error('Fetch module not loaded');
    const formData = new FormData(); if (content) formData.append('content', content);
    if (file) formData.append('file', file.buffer, { filename: file.originalname, contentType: file.mimetype });
    const response = await fetch(webhook.url, { method: 'POST', body: formData, headers: formData.getHeaders(), timeout: 10000 });
    if (!response.ok) { const errorText = await response.text(); throw new Error(`Failed to send message to Discord: ${response.status} - ${errorText}`); }
    return res.json({ success: true });
  } catch (error) {
    console.error(`Error sending message: ${error.message}`);
    return res.status(500).json({ error: error.message });
  }
});

app.delete('/webhook/:id', (req, res) => {
  const { id } = req.params, index = webhooks.findIndex(w => w.id === id);
  if (index === -1) return res.status(404).json({ error: 'Webhook not found' });
  webhooks.splice(index, 1);
  return res.json({ success: true });
});

app.get('/messages/:channelId', async (req, res) => {
  try {
    const channel = await client.channels.fetch(req.params.channelId, { force: true });
    if (!channel?.isTextBased?.()) return res.status(400).json({ error: 'Channel not found or not text-based' });
    const perms = channel.permissionsFor(channel.guild.members.me);
    if (!perms.has([PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory])) return res.status(403).json({ error: 'Missing permissions' });
    const msgs = await channel.messages.fetch({ limit: 50 });
    const formatted = msgs.map(msg => ({ id: msg.id, content: msg.content, author: { username: msg.author.username, avatar: msg.author.avatarURL() || 'https://cdn.discordapp.com/embed/avatars/0.png' }, timestamp: msg.createdAt.toISOString(), embeds: msg.embeds.map(e => ({ title: e.title, description: e.description, fields: e.fields.map(f => ({ name: f.name, value: f.value })), thumbnail: e.thumbnail?.url ? { url: e.thumbnail.url } : null, image: e.image?.url ? { url: e.image.url } : null })), attachments: msg.attachments.map(a => ({ url: a.url, filename: a.name, contentType: a.contentType })) }));
    return res.json(formatted);
  } catch (error) {
    console.error(`Error fetching messages: ${error.message}`);
    return res.status(500).json({ error: `Failed to fetch messages: ${error.message}` });
  }
});

// Static files and SPA fallback
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.status(404).json({ error: 'Not found' }));

client.once('ready', () => console.log(`Logged in as ${client.user.tag}`));
client.login(process.env.BOT_TOKEN).catch(err => { console.error(`Discord login error: ${err.message}`); process.exit(1); });

// HTTPS or HTTP server start
if (process.env.NODE_ENV === 'production' && process.env.USE_LOCAL_HTTPS === 'true') {
  const key = fs.readFileSync(process.env.SSL_KEY_PATH, 'utf8');
  const cert = fs.readFileSync(process.env.SSL_CERT_PATH, 'utf8');
  https.createServer({ key, cert }, app).listen(port, '0.0.0.0', () => console.log(`HTTPS Server running on port ${port}`));
} else {
  app.listen(port, '0.0.0.0', () => console.log(`Server running on port ${port}`));
}
