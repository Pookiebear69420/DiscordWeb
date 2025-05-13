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
app.set('trust proxy', 1); // Trust first proxy (e.g., Render)
const port = process.env.PORT || 3000;

// Serve static files
app.use(express.static(__dirname));

// Root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Rate limiting middleware
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});
app.use(limiter);

// CORS configuration
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE'],
  credentials: true
}));

app.use(express.json());

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

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const upload = multer({ limits: { fileSize: 8 * 1024 * 1024 } }); // 8MB limit
const webhooks = [];

// Cache and cooldown maps
const webhookCache = new Map();
const lastAttempts = new Map();

// Fully-proofed validateWebhook
async function validateWebhook(url) {
  const now = Date.now();
  const cooldownMs = 5000; // 5 seconds per URL

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

// Add-webhook route with backoff and cache
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
    return res.json({
      webhook,
      privacyNotice: 'Webhook URLs are stored locally and sent to this server for processing. Ensure you trust the server operator.'
    });

  } catch (error) {
    return res.status(429).json({ error: error.message });
  }
});

// Send-message, delete, get-messages unchanged...
// ... (rest of your existing routes here) ...

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.login(process.env.BOT_TOKEN).catch(error => {
  console.error(`Failed to login to Discord: ${error.message}`);
  process.exit(1);
});

// HTTPS setup
if (process.env.NODE_ENV === 'production' && process.env.USE_LOCAL_HTTPS === 'true') {
  const privateKey = fs.readFileSync(process.env.SSL_KEY_PATH, 'utf8');
  const certificate = fs.readFileSync(process.env.SSL_CERT_PATH, 'utf8');
  const httpsServer = https.createServer({ key: privateKey, cert: certificate }, app);
  httpsServer.listen(port, '0.0.0.0', () => console.log(`HTTPS Server running on port ${port}`));
} else {
  app.listen(port, '0.0.0.0', () => console.log(`Server running on port ${port}`));
}
