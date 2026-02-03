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

// ✅ NEON DATABASE CONNECTION
const pool = new Pool({
    connectionString: "postgresql://neondb_owner:npg_7hti3UfsCNXz@ep-late-feather-a1xou2rw-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require",
    ssl: { rejectUnauthorized: false }
});

let latestTrapHit = null;

// Database Initialization
const initDB = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS scam_intel_final_v3 (
                id SERIAL PRIMARY KEY,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                scam_type VARCHAR(100),
                mobile_numbers TEXT,
                bank_accounts TEXT,
                raw_message TEXT
            );
        `);
        console.log("✅ Ramesh AI Ready: Database Connected (Neon Cloud)");
    } catch (err) { console.error("❌ DB Error:", err); }
};
initDB();

// Intelligence Extractor Function
function extractIntelFromText(txt) {
    if (!txt) return { mobiles: [], accounts: [], ifsc: null, upi: null, links: [], name: null };
    const mobiles = txt.match(/(?:\+91|91|0)\s?-?\s?([6-9]\d{9})\b/g) || [];
    const accounts = txt.match(/\b\d{9,18}\b/g) || [];
    const upiMatch = txt.match(/[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}/);
    const links = txt.match(/(?:https?:\/\/|www\.|bit\.ly|tinyurl)[^\s]+/gi) || [];
    const nameMatch = txt.match(/(?:name is|officer|mr\.|mr|dr\.|manager)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/i);

    return {
        name: nameMatch ? nameMatch[1] : "Unknown",
        mobiles: [...new Set(mobiles)], 
        accounts: [...new Set(accounts)],
        upi: upiMatch ? upiMatch[0] : null,
        links: links
    };
}

app.get('/', (req, res) => {
    res.send(`<h1>✅ Ramesh AI Ready: Database Connected</h1>`);
});

// ==========================================
// 🧠 MAIN CHAT AGENT (With 10th Feb Fixes)
// ==========================================
app.post('/api/chat', async (req, res) => {
    const incomingKey = req.headers['x-api-key'];
    if (incomingKey && incomingKey !== HACKATHON_API_KEY) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    try {
        const { message, conversationHistory } = req.body;
        
        // 🛠️ SMART BODY PARSER: Handles both string and object
        let txt = (typeof message === 'object' && message !== null) ? message.text || "" : message || "";
        if (!txt) return res.status(400).json({ error: "INVALID_REQUEST_BODY" });

        const history = conversationHistory || [];
        const info = extractIntelFromText(txt);

        // --- AI CALL WITH RETRY & FALLBACK ---
        let uiReply = "";
        let retryCount = 0;
        const maxRetries = 2;

        while (retryCount <= maxRetries) {
            try {
                const completion = await groq.chat.completions.create({ 
                    messages: [
                        { role: "system", content: "You are Ramesh, a 65-year-old retired Indian man. Speak in Hinglish. Goal: Waste scammer's time. Act confused." },
                        ...history.slice(-6).map(m => ({ role: m.sender === 'scammer' ? 'user' : 'assistant', content: m.text })),
                        { role: "user", content: txt }
                    ], 
                    model: retryCount === 0 ? "llama-3.3-70b-versatile" : "llama3-8b-8192" 
                });
                uiReply = completion.choices[0]?.message?.content || "";
                break; 
            } catch (aiErr) {
                if (aiErr.status === 429 && retryCount < maxRetries) {
                    retryCount++;
                    console.log(`⚠️ Rate limit! Retrying... ${retryCount}`);
                    await new Promise(r => setTimeout(r, 1000));
                } else {
                    uiReply = "बेटा नेटवर्क नहीं आ रहा, फिर से बोलो?"; 
                    break;
                }
            }
        }

        const finalResponse = {
            status: "success",
            reply: uiReply,
            agent_reply: uiReply,
            classification: { verdict: "SCAM", confidence_score: 0.98, category: "Suspicious" },
            extracted_intelligence: {
                phone_numbers: info.mobiles,
                upi_ids: [info.upi].filter(Boolean),
                bank_accounts: info.accounts,
                phishing_links: info.links,
                scammer_name: info.name
            },
            metadata: { timestamp: new Date().toISOString() }
        };

        // Save to Neon Database
        pool.query(`INSERT INTO scam_intel_final_v3 (scam_type, mobile_numbers, bank_accounts, raw_message) VALUES ($1, $2, $3, $4)`, 
        ["Scam Attempt", info.mobiles.join(','), info.accounts.join(','), txt]).catch(e => console.error(e));

        res.json(finalResponse);

    } catch (error) {
        res.status(500).json({ status: "error", message: "Server Error" });
    }
});

app.listen(PORT, () => console.log(`🚀 Ramesh 17.0 (10th Feb Finale Ready) on port ${PORT}`));

// ✅ KEEP-ALIVE: Prevent Render from sleeping during the demo
setInterval(() => {
    const myUrl = "https://kisan-hackathon-bot.onrender.com"; 
    https.get(myUrl, (res) => { console.log("Self-Ping: Awake!"); }).on('error', (e) => {});
}, 840000); // Pings every 14 minutes










