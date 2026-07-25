// ============================================================
// Naira Chat Wallet — WhatsApp Bot Server
// ============================================================
// A simulated wallet that runs on real WhatsApp, using the
// WhatsApp Business Cloud API (Meta).
//
// No real money moves. Balances live in a local JSON file
// (wallet-data.json) and reset only if you delete that file.
//
// Built with zero external dependencies — just Node's built-in
// modules — so it runs anywhere without "npm install" issues.
// ============================================================

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ---------- Configuration ----------
// These come from environment variables, set on your hosting
// provider (Render/Railway) — never hard-code real tokens here.
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'naira-wallet-demo'; // you choose this string
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || '';             // from Meta dashboard
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || '';           // from Meta dashboard
const GRAPH_API_VERSION = 'v20.0';

// ---------- Simple JSON "database" ----------
const DB_PATH = path.join(__dirname, 'wallet-data.json');

function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    const initial = { users: {} };
    fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function getUser(phone) {
  const db = loadDB();
  if (!db.users[phone]) {
    db.users[phone] = {
      phone,
      name: null,
      balance: 5000, // everyone starts with a demo balance of ₦5,000
      history: [],
      pendingAction: null // used for multi-step flows (e.g. bill payment)
    };
    saveDB(db);
  }
  return db.users[phone];
}

function saveUser(user) {
  const db = loadDB();
  db.users[user.phone] = user;
  saveDB(db);
}

function fmtNaira(n) {
  return '₦' + n.toLocaleString('en-NG');
}

function addHistory(user, entry) {
  user.history.unshift({ ...entry, date: new Date().toISOString() });
  user.history = user.history.slice(0, 10); // keep last 10
}

// ---------- Sending messages back via WhatsApp Cloud API ----------
function sendWhatsAppMessage(toPhone, text) {
  return new Promise((resolve, reject) => {
    if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
      console.log(`[DRY RUN — no WhatsApp credentials set] Would send to ${toPhone}:\n${text}\n`);
      return resolve();
    }

    const payload = JSON.stringify({
      messaging_product: 'whatsapp',
      to: toPhone,
      type: 'text',
      text: { body: text }
    });

    const options = {
      hostname: 'graph.facebook.com',
      path: `/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          console.error('WhatsApp API error:', res.statusCode, data);
          reject(new Error(data));
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ---------- Wallet command logic ----------
// This mirrors exactly what the browser demo showed:
// balance, send, airtime, pay bills, history
async function handleMessage(fromPhone, rawText) {
  const user = getUser(fromPhone);
  const text = (rawText || '').trim().toLowerCase();

  // --- Multi-step flow: bill payment in progress ---
  if (user.pendingAction && user.pendingAction.type === 'bill_amount') {
    const amount = parseInt(text.replace(/[^0-9]/g, ''), 10);
    if (!amount || amount <= 0) {
      return reply(fromPhone, "That doesn't look like a valid amount. Please enter a number, e.g. 3000");
    }
    if (amount > user.balance) {
      user.pendingAction = null;
      saveUser(user);
      return reply(fromPhone, `You don't have enough balance for that. Your balance is ${fmtNaira(user.balance)}.`);
    }
    user.balance -= amount;
    addHistory(user, { type: 'debit', label: `${user.pendingAction.billType} bill payment`, amount });
    user.pendingAction = null;
    saveUser(user);
    return reply(fromPhone,
      `⚡️ Payment successful — ${fmtNaira(amount)} paid for ${user.pendingAction ? '' : ''}your bill.\nNew balance: ${fmtNaira(user.balance)}`
    );
  }

  if (user.pendingAction && user.pendingAction.type === 'bill_select') {
    const options = { '1': 'Electricity', '2': 'Water', '3': 'Internet', '4': 'Cable TV' };
    const chosen = options[text];
    if (!chosen) {
      return reply(fromPhone, "Please reply with a number from 1 to 4.");
    }
    user.pendingAction = { type: 'bill_amount', billType: chosen };
    saveUser(user);
    return reply(fromPhone, `How much would you like to pay for ${chosen}?`);
  }

  // --- Standing commands ---

  // Balance check
  if (text === 'balance' || text === 'bal') {
    return reply(fromPhone, `💰 Your balance is ${fmtNaira(user.balance)}.\n\nType *send*, *airtime*, *pay bills*, or *history* to do more.`);
  }

  // Airtime top-up: "airtime 500"
  if (text.startsWith('airtime')) {
    const amount = parseInt(text.replace(/[^0-9]/g, ''), 10);
    if (!amount || amount <= 0) {
      return reply(fromPhone, "To buy airtime, type it like this: *airtime 500*");
    }
    if (amount > user.balance) {
      return reply(fromPhone, `You don't have enough balance. Your balance is ${fmtNaira(user.balance)}.`);
    }
    user.balance -= amount;
    addHistory(user, { type: 'debit', label: 'Airtime top-up', amount });
    saveUser(user);
    return reply(fromPhone, `📱 ${fmtNaira(amount)} airtime credited instantly.\nNew balance: ${fmtNaira(user.balance)}`);
  }

  // Bill payment flow: "pay bills"
  if (text === 'pay bills' || text === 'bills') {
    user.pendingAction = { type: 'bill_select' };
    saveUser(user);
    return reply(fromPhone, `Which bill would you like to pay?\n\n1️⃣ Electricity\n2️⃣ Water\n3️⃣ Internet\n4️⃣ Cable TV`);
  }

  // Send money: "send 2000 to 08012345678" or "send 2000 to Femi"
  if (text.startsWith('send')) {
    const amountMatch = text.match(/send\s+(\d+)/);
    const toMatch = text.match(/to\s+(.+)/);
    const amount = amountMatch ? parseInt(amountMatch[1], 10) : null;
    const recipient = toMatch ? toMatch[1].trim() : null;

    if (!amount || !recipient) {
      return reply(fromPhone, "To send money, type it like this: *send 2000 to 08012345678*");
    }
    if (amount > user.balance) {
      return reply(fromPhone, `You don't have enough balance. Your balance is ${fmtNaira(user.balance)}.`);
    }

    user.balance -= amount;
    addHistory(user, { type: 'debit', label: `Sent to ${recipient}`, amount });
    saveUser(user);

    // If recipient looks like a phone number we know about, credit them too (real P2P demo)
    const digits = recipient.replace(/[^0-9]/g, '');
    if (digits.length >= 10) {
      const db = loadDB();
      const recipientPhone = digits;
      if (db.users[recipientPhone]) {
        const recipientUser = db.users[recipientPhone];
        recipientUser.balance += amount;
        addHistory(recipientUser, { type: 'credit', label: `From ${fromPhone}`, amount });
        db.users[recipientPhone] = recipientUser;
        saveDB(db);
        sendWhatsAppMessage(recipientPhone,
          `💰 You've received ${fmtNaira(amount)} from ${fromPhone}.\nNew balance: ${fmtNaira(recipientUser.balance)}`
        ).catch(err => console.error('Failed to notify recipient:', err.message));
      }
    }

    return reply(fromPhone, `✅ ${fmtNaira(amount)} sent to ${recipient}.\nNew balance: ${fmtNaira(user.balance)}`);
  }

  // Transaction history
  if (text === 'history') {
    if (user.history.length === 0) {
      return reply(fromPhone, "No transactions yet. Try *send 500 to 08012345678* or *airtime 500*.");
    }
    const lines = user.history.slice(0, 5).map(h => {
      const sign = h.type === 'credit' ? '+' : '−';
      return `${sign} ${fmtNaira(h.amount)} — ${h.label}`;
    });
    return reply(fromPhone, `📋 Last transactions:\n\n${lines.join('\n')}`);
  }

  // Greeting / help / fallback
  if (['hi', 'hello', 'hey', 'start', 'menu'].includes(text)) {
    return reply(fromPhone,
      `Hi 👋 Welcome to Naira Wallet (demo).\n\nYour balance: ${fmtNaira(user.balance)}\n\nTry:\n• *balance*\n• *send 2000 to 08012345678*\n• *airtime 500*\n• *pay bills*\n• *history*`
    );
  }

  return reply(fromPhone,
    `Sorry, I didn't understand that. Try:\n• *balance*\n• *send 2000 to 08012345678*\n• *airtime 500*\n• *pay bills*\n• *history*`
  );
}

function reply(toPhone, text) {
  return sendWhatsAppMessage(toPhone, text);
}

// ---------- HTTP server: webhook endpoints ----------
const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);

  // Meta calls this once, with GET, to verify your webhook URL
  if (req.method === 'GET' && parsedUrl.pathname === '/webhook') {
    const mode = parsedUrl.searchParams.get('hub.mode');
    const token = parsedUrl.searchParams.get('hub.verify_token');
    const challenge = parsedUrl.searchParams.get('hub.challenge');

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(challenge);
    } else {
      res.writeHead(403);
      res.end('Verification failed');
    }
    return;
  }

  // Meta sends incoming messages here, as POST
  if (req.method === 'POST' && parsedUrl.pathname === '/webhook') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      res.writeHead(200);
      res.end('OK'); // acknowledge quickly, Meta expects a fast response

      try {
        const payload = JSON.parse(body);
        const entry = payload.entry && payload.entry[0];
        const change = entry && entry.changes && entry.changes[0];
        const value = change && change.value;
        const message = value && value.messages && value.messages[0];

        if (message && message.type === 'text') {
          const fromPhone = message.from; // sender's WhatsApp number
          const text = message.text.body;
          console.log(`Incoming from ${fromPhone}: ${text}`);
          await handleMessage(fromPhone, text);
        }
      } catch (err) {
        console.error('Error handling webhook payload:', err);
      }
    });
    return;
  }

  // Simple health check for hosting providers
  if (req.method === 'GET' && parsedUrl.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Naira Chat Wallet bot is running.');
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Naira Chat Wallet server listening on port ${PORT}`);
  console.log(`Webhook verify token: ${VERIFY_TOKEN}`);
  if (!WHATSAPP_TOKEN) {
    console.log('⚠️  WHATSAPP_TOKEN not set — running in DRY RUN mode (replies print to console only).');
  }
});
