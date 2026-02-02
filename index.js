require('dotenv').config(); 
require('dns').setDefaultResultOrder('ipv4first');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const Groq = require("groq-sdk");
const { Pool } = require('pg');
const https = require('https'); 

const app = express();
app.use(bodyParser.json({ limit: '50mb' }));
app.use(cors());

// --- ⚙️ CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY; 
const HACKATHON_API_KEY = process.env.HACKATHON_API_KEY || "my_secret_hackathon_key";

const groq = new Groq({ apiKey: GROQ_API_KEY });

const pool = new Pool({
    connectionString: "postgresql://neondb_owner:npg_7hti3UfsCNXz@ep-late-feather-a1xou2rw-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require",
    ssl: { rejectUnauthorized: false }
});

let latestTrapHit = null;

const initDB = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS scam_intel_final_v3 (
                id SERIAL PRIMARY KEY,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                scam_type VARCHAR(100),
                mobile_numbers TEXT,
                bank_accounts TEXT,
                upi_id VARCHAR(255),
                ifsc_code VARCHAR(100),
                captured_ip VARCHAR(100),
                raw_message TEXT
            );
        `);
        console.log("✅ Ramesh AI Ready: Database Connected (Clean Dashboard)");
    } catch (err) { console.error("❌ DB Error:", err); }
};
initDB();

function getBankNameFromIFSC(ifsc) {
    if (!ifsc) return "Unknown Bank";
    const code = ifsc.substring(0, 4).toUpperCase();
    const banks = { "SBIN": "State Bank of India", "HDFC": "HDFC Bank", "ICIC": "ICICI Bank", "PUNB": "Punjab National Bank", "BARB": "Bank of Baroda", "CNRB": "Canara Bank", "UTIB": "Axis Bank", "BKID": "Bank of India", "PYTM": "Paytm Payments Bank" };
    return banks[code] || "Other Bank";
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/api/log-device', async (req, res) => {
    let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (ip && ip.includes(',')) ip = ip.split(',')[0].trim();
    latestTrapHit = { ip: ip, deviceInfo: req.body, timestamp: new Date().toISOString() };
    try { await pool.query(`INSERT INTO scam_intel_final_v3 (scam_type, captured_ip) VALUES ($1, $2)`, ['Trap Link Clicked', ip]); } catch(e) {}
    res.json({ status: "success" });
});

app.get('/payment-proof/:id', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>Receipt</title></head><body><h1 style="text-align:center; color:green;">✅ Payment Successful</h1><script>fetch('/api/log-device',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userAgent:navigator.userAgent})});</script></body></html>`);
});

// ==========================================
// 🟢 INTELLIGENCE EXTRACTOR (SMART FILTER)
// ==========================================
function extractIntelFromText(txt) {
    if (!txt) return { mobiles: [], accounts: [], ifsc: null, upi: null, links: [], name: null };

    let mobiles = [];
    let accounts = [];
    
    // Step 1: Specific Mobiles (+91, etc)
    const specificMobileRegex = /(?:\+91|91|0)\s?-?\s?([6-9]\d{9})\b/g;
    let tempTxt = txt; 
    let mMatch;
    while ((mMatch = specificMobileRegex.exec(txt)) !== null) {
        mobiles.push(mMatch[1]);
        tempTxt = tempTxt.replace(mMatch[0], "X".repeat(mMatch[0].length));
    }

    // Step 2: General Numbers
    const generalNumberRegex = /\b\d{9,18}\b/g;
    let gMatch;
    while ((gMatch = generalNumberRegex.exec(tempTxt)) !== null) {
        let num = gMatch[0];
        if (/^[6-9]\d{9}$/.test(num)) {
            mobiles.push(num);
        } else {
            accounts.push(num);
        }
    }

    const ifscRegex = /[A-Z]{4}0[A-Z0-9]{6}/i;
    const ifscMatch = txt.match(ifscRegex);
    const upiMatch = txt.match(/[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}/);
    const links = txt.match(/(?:https?:\/\/|www\.|bit\.ly|tinyurl)[^\s]+/gi);
    const nameMatch = txt.match(/(?:name is|officer|mr\.|mr|dr\.|manager)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/i);

    return {
        name: nameMatch ? nameMatch[1] : null,
        mobiles: [...new Set(mobiles)], 
        accounts: [...new Set(accounts)],
        ifsc: ifscMatch ? ifscMatch[0].toUpperCase() : null,
        upi: upiMatch ? upiMatch[0] : null,
        links: links || []
    };
}

// ==========================================
// 🧠 MAIN CHAT AGENT
// ==========================================
app.post('/api/chat', async (req, res) => {
    const incomingKey = req.headers['x-api-key'];
    if (incomingKey && incomingKey !== HACKATHON_API_KEY) {
        return res.status(401).json({ error: "Unauthorized: Invalid API Key" });
    }

    try {
        const { message, conversationHistory } = req.body;
        const txt = message?.text || "";
        const history = conversationHistory || [];

        // 1. Data Extraction
        let memory = { names: [], mobiles: [], accounts: [], ifscs: [], upis: [], links: [] };
        const allMessages = [...history, { sender: 'scammer', text: txt }];

        allMessages.forEach(msg => {
            if (msg.sender === 'scammer') {
                const info = extractIntelFromText(msg.text);
                if (info.name) memory.names.push(info.name);
                if (info.mobiles.length) memory.mobiles.push(...info.mobiles);
                if (info.accounts.length) memory.accounts.push(...info.accounts);
                if (info.ifsc) memory.ifscs.push(info.ifsc);
                if (info.upi) memory.upis.push(info.upi);
                if (info.links.length) memory.links.push(...info.links);
            }
        });

        // 2. Scam Type
        let scamType = "Suspicious Activity";
        let mood = "NEUTRAL";
        const fullConversation = allMessages.map(m => m.text).join(" ").toLowerCase();

        if (fullConversation.match(/video call|nude|sex|girl/i)) { scamType = "Sextortion"; mood = "THREATENING"; }
        else if (fullConversation.match(/franchise|dealership/i)) { scamType = "Franchise Fraud"; }
        else if (fullConversation.match(/police|cbi|arrest/i)) { scamType = "Digital Arrest"; mood = "URGENT"; }
        else if (fullConversation.match(/otp|anydesk/i)) { scamType = "Tech Support Scam"; }

        // 3. Natural System Prompt
        let systemPrompt = `You are Ramesh, a 65-year-old retired Indian man. You speak in a mix of Hindi and English (Hinglish).
        
        YOUR GOAL: Waste the scammer's time. Act like a confused victim.
        
        CRITICAL RULES:
        1. **NEVER offer money first.** Only talk about payment if they ask.
        2. **OTP/Link:** Say "Samajh nahi aa raha" or "Khul nahi raha". Do not pay instead.
        3. **Threats:** Act scared. Beg for mercy.
        4. **Payment:** ONLY when they ask for Money/Transfer, say "UPI nahi chal raha, Bank Account number do".

        Tone: Polite, scared, confused ("Bhaiya", "Beta", "Sir"). Keep replies short.`;

        let chatMessages = [{ role: "system", content: systemPrompt }];
        const recentHistory = history.slice(-8);
        recentHistory.forEach(msg => chatMessages.push({ role: msg.sender === 'scammer' ? 'user' : 'assistant', content: msg.text }));
        chatMessages.push({ role: "user", content: txt });

        let uiReply = "...";
        try {
            const completion = await groq.chat.completions.create({ 
                messages: chatMessages, 
                model: "llama-3.3-70b-versatile"
            });
            uiReply = completion.choices[0]?.message?.content || "Hmm...";
            if (uiReply.trim().startsWith('{')) {
                try {
                    const parsed = JSON.parse(uiReply);
                    uiReply = parsed.reply || parsed.message || uiReply;
                } catch(e) {}
            }
        } catch(e) { 
            console.error("AI Error:", e);
            uiReply = "Beta network chala gaya tha..."; 
        }

        // Trap Logic
        const hasAccount = memory.accounts.length > 0;
        const hasIFSC = memory.ifscs.length > 0;
        
        if (hasAccount && hasIFSC && (uiReply.toLowerCase().includes("sent") || uiReply.toLowerCase().includes("transfer"))) {
            const protocol = req.headers['x-forwarded-proto'] || 'http'; 
            const link = `${protocol}://${req.headers['host']}/payment-proof/txn_${Math.floor(Math.random()*10000)}`;
            uiReply += ` Receipt dekho: ${link}`;
        }

        const detectedIP = latestTrapHit ? latestTrapHit.ip : (req.headers['x-forwarded-for'] || "Simulated_Bot_Network");

        const finalResponse = {
            status: "success",
            reply: uiReply,        
            agent_reply: uiReply,
            classification: { verdict: "SCAM", confidence_score: 0.98, category: scamType },
            // 🟢 CLEAN: 'ip_address' removed from extracted_intelligence
            extracted_intelligence: {
                phone_numbers: memory.mobiles,
                upi_ids: memory.upis,
                bank_accounts: memory.accounts,
                ifsc_codes: memory.ifscs,
                phishing_links: memory.links,
                scammer_name: memory.names[0] || "Unknown"
            },
            // Old format kept for safety, but IP logic removed
            extracted_entities: {
                mobile_numbers: memory.mobiles,
                bank_account_numbers: memory.accounts,
                ifsc_code: memory.ifscs[0] || null,
                bank_name: getBankNameFromIFSC(memory.ifscs[0]),
                upi_id: memory.upis[0] || null,
                phishing_links: memory.links
            },
            metadata: { timestamp: new Date().toISOString(), scammer_mood: mood }
        };

        if (memory.mobiles.length || memory.accounts.length) {
            pool.query(`INSERT INTO scam_intel_final_v3 (scam_type, mobile_numbers, bank_accounts, ifsc_code, raw_message) VALUES ($1, $2, $3, $4, $5)`, 
            [scamType, memory.mobiles.join(','), memory.accounts.join(','), memory.ifscs[0] || null, txt]).catch(e => console.error(e));
        }

        res.json(finalResponse);

    } catch (error) {
        console.error("Server Error:", error);
        res.status(500).json({ status: "error", message: "Server Error" });
    }
});

app.listen(PORT, () => console.log(`🚀 Ramesh 17.0 (No Faltu IP) running on port ${PORT}`));

setInterval(() => {
    const myUrl = "https://YOUR-APP-NAME.onrender.com"; 
    if (myUrl.includes("YOUR-APP-NAME")) return; 
    https.get(myUrl, (res) => {}).on('error', (e) => console.error("Ping Error:", e.message));
}, 840000);










