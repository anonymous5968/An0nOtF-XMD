const express = require("express");
const path = require("path");
const fs = require("fs-extra");
const pairingManager = require("./pairing");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(__dirname));  // Serve from current directory
// Create necessary directories
fs.ensureDirSync(path.join(__dirname, "sessions"));
fs.ensureDirSync(path.join(__dirname, "temp"));

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.post("/generate-code", async (req, res) => {
    let { phoneNumber } = req.body;
    
    try {
        phoneNumber = phoneNumber.replace(/[\s+\-]/g, "");
        
        if (!/^\d{10,15}$/.test(phoneNumber)) {
            return res.json({ 
                success: false, 
                error: "Invalid phone number. Use 10-15 digits (e.g., 254111255045)" 
            });
        }
        
        console.log("📞 An0nOtF Pairing request for:", phoneNumber);
        const pairingData = await pairingManager.generatePairingCode(phoneNumber);
        res.json(pairingData);
        
    } catch (error) {
        console.error("An0nOtF Pairing error:", error);
        res.json({ 
            success: false, 
            error: "Server error: " + error.message,
            message: "Internal server error. Try again later."
        });
    }
});

app.get("/pairing-status/:sessionId", (req, res) => {
    try {
        const status = pairingManager.getPairingStatus(req.params.sessionId);
        res.json(status);
    } catch (error) {
        res.json({ 
            status: "error", 
            error: error.message,
            message: "Failed to check status"
        });
    }
});

// Get QR code for session
app.get("/qr-code/:sessionId", async (req, res) => {
    try {
        const sessionId = req.params.sessionId;
        const sessionPath = path.join(__dirname, "sessions", sessionId);
        
        if (!fs.existsSync(sessionPath)) {
            return res.status(404).json({ error: "Session not found" });
        }
        
        // Check for QR code in session info
        const sessionInfoPath = path.join(sessionPath, "session-info.json");
        if (fs.existsSync(sessionInfoPath)) {
            const sessionInfo = JSON.parse(fs.readFileSync(sessionInfoPath, "utf8"));
            if (sessionInfo.qrCode) {
                return res.json({ qr: sessionInfo.qrCode });
            }
        }
        
        // QR not ready yet
        res.status(202).json({ message: "QR code not ready yet" });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get("/session-data/:sessionId", async (req, res) => {
    try {
        const sessionId = req.params.sessionId;
        const sessionPath = path.join(__dirname, "sessions", sessionId);
        
        if (!fs.existsSync(sessionPath)) {
            return res.status(404).json({ 
                error: "Session not found",
                message: "Session expired or was cleaned up"
            });
        }
        
        // Get session data
        const authInfoPath = path.join(sessionPath, "auth_info_multi.json");
        let sessionData = {};
        
        if (fs.existsSync(authInfoPath)) {
            sessionData = JSON.parse(fs.readFileSync(authInfoPath, "utf8"));
        } else {
            const files = fs.readdirSync(sessionPath);
            for (const file of files) {
                if (file.endsWith('.json')) {
                    try {
                        const content = JSON.parse(fs.readFileSync(path.join(sessionPath, file), 'utf8'));
                        if (content.creds || content.WABrowserId) {
                            sessionData = content;
                            break;
                        }
                    } catch (e) {
                        continue;
                    }
                }
            }
        }
        
        if (Object.keys(sessionData).length === 0) {
            return res.status(404).json({ 
                error: "No session data found",
                message: "Session data incomplete"
            });
        }
        
        // Also get session info
        const sessionInfoPath = path.join(sessionPath, "session-info.json");
        let sessionInfo = {};
        if (fs.existsSync(sessionInfoPath)) {
            sessionInfo = JSON.parse(fs.readFileSync(sessionInfoPath, "utf8"));
        }
        
        res.json({
            success: true,
            sessionId: sessionId,
            sessionData: sessionData,
            sessionInfo: sessionInfo,
            message: "Session data retrieved successfully"
        });
        
    } catch (error) {
        res.status(404).json({ 
            success: false,
            error: error.message,
            message: "Failed to load session data"
        });
    }
});

// Download session file
app.get("/download-session/:sessionId", async (req, res) => {
    try {
        const sessionId = req.params.sessionId;
        const sessionPath = path.join(__dirname, "sessions", sessionId);
        
        if (!fs.existsSync(sessionPath)) {
            return res.status(404).json({ 
                error: "Session not found",
                message: "Session expired or was cleaned up"
            });
        }
        
        const authInfoPath = path.join(sessionPath, "auth_info_multi.json");
        let sessionData = {};
        
        if (fs.existsSync(authInfoPath)) {
            sessionData = JSON.parse(fs.readFileSync(authInfoPath, "utf8"));
        }
        
        if (Object.keys(sessionData).length === 0) {
            return res.status(404).json({ 
                error: "No session data",
                message: "Session data incomplete"
            });
        }
        
        const fileName = `An0nOtF-session-${sessionId}.json`;
        const fileContent = JSON.stringify(sessionData, null, 2);
        
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
        res.send(fileContent);
        
    } catch (error) {
        res.status(404).json({ 
            error: error.message,
            message: "Failed to generate session file"
        });
    }
});

app.get("/full-config/:sessionId", async (req, res) => {
    try {
        const sessionId = req.params.sessionId;
        const sessionPath = path.join(__dirname, "sessions", sessionId);
        
        if (!fs.existsSync(sessionPath)) {
            return res.status(404).json({ 
                error: "Session not found",
                message: "Session expired or was cleaned up"
            });
        }
        
        const sessionInfoPath = path.join(sessionPath, "session-info.json");
        let sessionInfo = {};
        
        if (fs.existsSync(sessionInfoPath)) {
            sessionInfo = JSON.parse(fs.readFileSync(sessionInfoPath, "utf8"));
        }
        
        const authInfoPath = path.join(sessionPath, "auth_info_multi.json");
        let sessionData = {};
        
        if (fs.existsSync(authInfoPath)) {
            sessionData = JSON.parse(fs.readFileSync(authInfoPath, "utf8"));
        }
        
        const completeConfig = `// An0nOtF V3💎 - WhatsApp Bot Configuration
// Generated: ${new Date().toISOString()}
// Phone: ${sessionInfo.phoneNumber || 'Unknown'}
// Session ID: ${sessionId}
// Developer: Tylor (@unknownnumeralx)
// Channel: @KenyaTechZone
// WhatsApp: Session file also sent to your WhatsApp!

// ==== SESSION DATA ====
const sessionData = ${JSON.stringify(sessionData, null, 4)};

// ==== CONFIG.JS ====
module.exports = {
    bot: {
        name: "An0nOtF V3💎",
        prefix: "!",
        admins: ["${sessionInfo.phoneNumber || ''}@s.whatsapp.net"],
        autoRead: true,
        autoTyping: false,
        developer: "Tylor",
        telegram: "@unknownnumeralx",
        channel: "@KenyaTechZone"
    },
    
    session: sessionData,
    
    mega: {
        email: "",
        password: "",
        enabled: false
    },
    
    plugins: {
        autoLoad: true,
        enabled: ["admin", "media", "fun", "tools", "download", "ai", "group"]
    },
    
    security: {
        encryption: true,
        maxFileSize: 100,
        allowedUsers: ["all"]
    },
    
    apis: {
        deepseek: "your-api-key",
        gemini: "your-api-key",
        weather: "your-api-key"
    }
};

// ==== HOW TO USE ====
// 1. Use the session file sent to your WhatsApp
// 2. Save it as "An0nOtF-session.json" in bot folder
// 3. Use: const { state } = await useSingleFileAuthState("./An0nOtF-session.json");
// 4. Start your bot - No QR needed!
// 5. Session also available on website for download
`;

        res.setHeader("Content-Type", "application/javascript");
        res.setHeader("Content-Disposition", "attachment; filename=An0nOtF-config.js");
        res.send(completeConfig);
        
    } catch (error) {
        res.status(404).json({ 
            error: error.message,
            message: "Failed to generate configuration"
        });
    }
});

// Cleanup failed session
app.delete("/cleanup-session/:sessionId", (req, res) => {
    try {
        pairingManager.cleanupSession(req.params.sessionId);
        res.json({ success: true, message: "Session cleaned up" });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.listen(PORT, () => {
    console.log("\n" + "=".repeat(50));
    console.log("🎉 An0nOtF V3💎 Pairing Server Started!");
    console.log("🔗 URL: http://localhost:" + PORT);
    console.log("👨‍💻 Developer: Tylor (@unknownnumeralx)");
    console.log("📢 Channel: @KenyaTechZone");
    console.log("💎 Powered by: @whiskeysockets/baileys");
    console.log("📱 QR Code + Pairing Code + WhatsApp Delivery");
    console.log("=".repeat(50) + "\n");
});