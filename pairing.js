const { default: makeWASocket, useMultiFileAuthState, delay, DisconnectReason } = require('@whiskeysockets/baileys');
const fs = require("fs-extra");
const path = require("path");

class PairingManager {
    constructor() {
        this.activePairings = new Map();
        this.phoneNumberLocks = new Map();
        this.sessionFolder = path.join(__dirname, "sessions");
        fs.ensureDirSync(this.sessionFolder);
    }

    async generatePairingCode(phoneNumber) {
        // Check if this phone number is already being paired
        if (this.phoneNumberLocks.has(phoneNumber)) {
            const existingSessionId = this.phoneNumberLocks.get(phoneNumber);
            const existingPairing = this.activePairings.get(existingSessionId);
            
            if (existingPairing && Date.now() - existingPairing.createdAt < 120000) {
                return {
                    success: true,
                    sessionId: existingSessionId,
                    code: existingPairing.code,
                    qr: existingPairing.qr,
                    message: "Already pairing this number. Use existing session.",
                    status: "already_pending"
                };
            }
        }

        const sessionId = "AN0N_" + Date.now();
        const sessionPath = path.join(this.sessionFolder, sessionId);
        
        console.log("🔐 An0nOtF XD-Baileys Pairing for:", phoneNumber);
        
        // Lock this phone number
        this.phoneNumberLocks.set(phoneNumber, sessionId);
        
        try {
            const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
            
            const sock = makeWASocket({
                auth: state,
                printQRInTerminal: false,
                browser: ["Ubuntu", "Chrome", "122.0.0.0"],
                connectTimeoutMs: 60000,
                keepAliveIntervalMs: 10000,
                defaultQueryTimeoutMs: 0,
                maxRetries: 3,
                syncFullHistory: false,
                markOnlineOnConnect: false,
                emitOwnEvents: true,
                fireInitQueries: true,
                retryRequestDelayMs: 2000,
                generateHighQualityLinkPreview: false,
                shouldIgnoreJid: () => false,
                // Important for pairing
                authTimeout: 45000,
                qrTimeout: 60000,
                transactionTimeoutMs: 30000
            });

            let pairingCode = null;
            let connectionOpen = false;
            let connectionError = null;
            let qrCode = null;
            let whatsappUserId = null;
            let sessionSent = false;
            let pairingCodeRequested = false;
            let pairingCodeAttempted = false;
            let pairingSuccess = false; // NEW: Track if pairing was successful
            let pairingComplete = false; // NEW: Track if pairing completed
            let restartRequired = false; // NEW: Track if restart is needed

            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, pairingCode: code, qr, isNewLogin } = update;
                
                console.log("🔄 Connection update:", { 
                    connection, 
                    code, 
                    qr: qr ? "QR received" : "no QR",
                    isNewLogin 
                });
                
                // Handle QR Code
                if (qr && !qrCode) {
                    qrCode = qr;
                    console.log("📱 QR Code generated");
                    
                    const pairingData = this.activePairings.get(sessionId);
                    if (pairingData) {
                        pairingData.qr = qr;
                        pairingData.status = "qr_generated";
                        pairingData.message = "QR code generated. Scan with WhatsApp";
                    }
                }
                
                // Handle successful connection
                if (connection === 'open') {
                    connectionOpen = true;
                    connectionError = null;
                    whatsappUserId = sock.user?.id;
                    console.log("✅ WhatsApp Connected!");
                    console.log("👤 User:", whatsappUserId || "Unknown");
                    
                    const pairingData = this.activePairings.get(sessionId);
                    if (pairingData) {
                        pairingData.status = "connected";
                        pairingData.connectedAt = new Date().toISOString();
                        pairingData.userId = whatsappUserId;
                        
                        // If we already have a pairing code, it means pairing is done
                        if (pairingCode) {
                            pairingData.message = "Pairing successful! Restarting connection...";
                            pairingData.status = "paired";
                            pairingSuccess = true;
                            
                            // Save credentials immediately
                            await saveCreds();
                            
                            // Schedule restart after a short delay
                            setTimeout(() => {
                                restartRequired = true;
                                pairingComplete = true;
                                console.log("🔄 Restarting connection with new credentials...");
                                sock.end();
                            }, 2000);
                        } else {
                            pairingData.message = "Connected to WhatsApp. Requesting pairing code...";
                        }
                    }
                }
                
                // NEW: Check if this is a new login after pairing
                if (isNewLogin) {
                    console.log("🔄 New login detected, restarting connection...");
                    pairingSuccess = true;
                    restartRequired = true;
                    
                    // Save credentials and restart
                    await saveCreds();
                    setTimeout(() => sock.end(), 1000);
                }
                
                // Request pairing code when QR is available
                if (qr && !pairingCodeRequested && !pairingCodeAttempted) {
                    pairingCodeAttempted = true;
                    
                    // Wait before requesting code
                    await delay(3000);
                    
                    try {
                        console.log("🔑 Requesting pairing code for:", phoneNumber);
                        const code = await sock.requestPairingCode(phoneNumber);
                        if (code) {
                            pairingCode = code;
                            pairingCodeRequested = true;
                            console.log("🎯 Pairing Code:", code);
                            
                            const pairingData = this.activePairings.get(sessionId);
                            if (pairingData) {
                                pairingData.code = code;
                                pairingData.status = "code_generated";
                                pairingData.message = `Pairing code: ${code} - Enter in WhatsApp`;
                                pairingData.codeGeneratedAt = new Date().toISOString();
                            }
                        }
                    } catch (pairError) {
                        console.log("❌ Could not get pairing code:", pairError.message);
                    }
                }
                
                if (connection === 'close') {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    const error = lastDisconnect?.error;
                    
                    let errorMessage = "Connection closed";
                    
                    if (statusCode === DisconnectReason.loggedOut) {
                        errorMessage = "❌ Device logged out from WhatsApp";
                    } else if (statusCode === DisconnectReason.connectionClosed) {
                        errorMessage = "🔌 Connection closed by server";
                    } else if (statusCode === DisconnectReason.connectionLost) {
                        errorMessage = "📡 Connection lost - check internet";
                    } else if (statusCode === DisconnectReason.timedOut) {
                        errorMessage = "⏰ Connection timed out";
                    } else if (statusCode === 515) { // NEW: Handle stream error 515
                        errorMessage = "🔄 Stream error - restart required";
                        restartRequired = true;
                    } else if (error) {
                        errorMessage = `⚠️ Error: ${error.message || "Unknown error"}`;
                    }
                    
                    connectionError = errorMessage;
                    
                    const pairingData = this.activePairings.get(sessionId);
                    if (pairingData) {
                        if (pairingSuccess) {
                            pairingData.status = "needs_restart";
                            pairingData.message = "Pairing successful! Connection needs to restart.";
                        } else {
                            pairingData.status = "error";
                            pairingData.message = errorMessage;
                            pairingData.error = error?.message || "Connection failed";
                        }
                    }
                    
                    // If pairing was successful, we need to reconnect
                    if (pairingSuccess && !pairingComplete) {
                        console.log("🔄 Pairing was successful, attempting to reconnect...");
                        
                        // Wait and reconnect with same credentials
                        await delay(3000);
                        
                        try {
                            // Reload auth state and reconnect
                            const { state: newState } = await useMultiFileAuthState(sessionPath);
                            
                            const newSock = makeWASocket({
                                auth: newState,
                                printQRInTerminal: false,
                                browser: ["Ubuntu", "Chrome", "122.0.0.0"],
                                connectTimeoutMs: 30000,
                                keepAliveIntervalMs: 10000
                            });
                            
                            // Update the socket in active pairings
                            if (pairingData) {
                                pairingData.sock = newSock;
                                pairingData.status = "reconnecting";
                                pairingData.message = "Reconnecting after successful pairing...";
                            }
                            
                            // Set up event listeners for new socket
                            newSock.ev.on('connection.update', (update) => {
                                if (update.connection === 'open') {
                                    console.log("✅ Reconnected successfully!");
                                    pairingComplete = true;
                                    
                                    if (pairingData) {
                                        pairingData.status = "ready";
                                        pairingData.message = "Ready to use!";
                                        pairingData.userId = newSock.user?.id;
                                        
                                        // Save session info
                                        this.saveSessionInfo(sessionId, phoneNumber, pairingCode, pairingData.userId);
                                        
                                        // Send session data
                                        this.sendSessionToWhatsAppAsText(newSock, sessionId, pairingData.userId);
                                        sessionSent = true;
                                    }
                                }
                            });
                            
                            newSock.ev.on('creds.update', saveCreds);
                            
                        } catch (reconnectError) {
                            console.error("❌ Failed to reconnect:", reconnectError);
                        }
                    } else {
                        // Remove phone number lock if pairing failed
                        if (this.phoneNumberLocks.get(phoneNumber) === sessionId) {
                            this.phoneNumberLocks.delete(phoneNumber);
                        }
                    }
                }
                
                if (connection === "connecting") {
                    console.log("🔄 Connecting to WhatsApp...");
                    const pairingData = this.activePairings.get(sessionId);
                    if (pairingData) {
                        pairingData.status = "connecting";
                        pairingData.message = "Connecting to WhatsApp servers...";
                    }
                }
            });

            sock.ev.on('creds.update', saveCreds);

            const pairingData = {
                phoneNumber: phoneNumber,
                sessionId: sessionId,
                sessionPath: sessionPath,
                sock: sock,
                status: "initializing",
                message: "Initializing pairing...",
                createdAt: Date.now(),
                whatsappUserId: null,
                sessionSent: false,
                qr: null,
                code: null
            };
            
            this.activePairings.set(sessionId, pairingData);
            
            // Wait for response
            await delay(20000); // Wait 20 seconds
            
            // Check what we have
            if (pairingSuccess) {
                return { 
                    success: true, 
                    sessionId: sessionId,
                    code: pairingCode,
                    message: "✅ Pairing successful! Your WhatsApp is now linked.",
                    qr: qrCode,
                    status: "paired",
                    needsRestart: restartRequired
                };
            } else if (pairingCode) {
                return { 
                    success: true, 
                    sessionId: sessionId,
                    code: pairingCode,
                    message: `Pairing code: ${pairingCode} - Enter in WhatsApp`,
                    qr: qrCode,
                    status: "code_generated"
                };
            } else if (qrCode) {
                return { 
                    success: true, 
                    sessionId: sessionId,
                    qr: qrCode,
                    message: "QR code generated. Scan with WhatsApp",
                    status: "qr_generated"
                };
            } else if (connectionError) {
                return { 
                    success: false, 
                    sessionId: sessionId,
                    error: connectionError,
                    message: connectionError
                };
            } else {
                return { 
                    success: false, 
                    sessionId: sessionId,
                    error: "Timeout",
                    message: "WhatsApp didn't respond. Try again"
                };
            }
            
        } catch (error) {
            console.error("❌ Pairing error:", error);
            
            // Remove lock on catch error
            if (this.phoneNumberLocks.get(phoneNumber) === sessionId) {
                this.phoneNumberLocks.delete(phoneNumber);
            }
            
            let userError = "Pairing failed";
            if (error.message.includes("timeout")) {
                userError = "Connection timeout";
            } else if (error.message.includes("ECONNREFUSED")) {
                userError = "Cannot connect to WhatsApp servers";
            } else if (error.message.includes("ENOTFOUND")) {
                userError = "Network error";
            } else if (error.message.includes("Invalid phone")) {
                userError = "Invalid phone number";
            } else if (error.message.includes("515")) {
                userError = "Pairing successful! Restart needed";
            }
            
            return { 
                success: false, 
                error: userError,
                message: `${userError}: ${error.message}`
            };
        }
    }

        // This method should come BEFORE checkPairingStatus
    async sendSessionToWhatsAppAsText(sock, sessionId, userId) {
        try {
            // Get session data
            const sessionData = this.getSessionDataForWhatsApp(sessionId);
            if (!sessionData) {
                console.log("❌ No session data to send");
                return;
            }

            // Convert session data to JSON string
            const sessionJSON = JSON.stringify(sessionData, null, 2);
            
            // Create formatted message
            const message = `🤖 *An0nOtF V3💎 - Session Data*\n\n` +
                           `✅ Your WhatsApp has been successfully paired!\n\n` +
                           `📱 *Number:* ${userId?.split(':')[0] || "Unknown"}\n` +
                           `🆔 *Session ID:* ${sessionId}\n` +
                           `📅 *Generated:* ${new Date().toLocaleString()}\n\n` +
                           `*📋 COPY THE JSON BELOW:*\n` +
                           `\`\`\`json\n${sessionJSON}\n\`\`\`\n\n` +
                           `*💾 How to save:*\n` +
                           `1. Copy ALL the JSON above (between \`\`\`json and \`\`\`)\n` +
                           `2. Create a file named: *An0nOtF-session.json*\n` +
                           `3. Paste the JSON into the file\n` +
                           `4. Save it in your bot folder\n` +
                           `5. Use with: *useSingleFileAuthState("./An0nOtF-session.json")*\n` +
                           `6. Start your bot - No QR needed! 🎉\n\n` +
                           `💎 *An0nOtF V3💎 - Developed by Tylor (@unknownnumeralx)*\n` +
                           `📢 *Channel:* @KenyaTechZone`;
            
            // Send message (to user's own chat since bot is using their account)
            await sock.sendMessage(userId, { 
                text: message 
            });
            
            console.log("📤 Session data sent as text to WhatsApp:", userId);
            
            // Mark as sent
            const pairingData = this.activePairings.get(sessionId);
            if (pairingData) {
                pairingData.sessionSent = true;
            }
            
        } catch (error) {
            console.error("❌ Failed to send session data via WhatsApp:", error);
        }
    }

    getSessionDataForWhatsApp(sessionId) {
        try {
            const sessionPath = path.join(this.sessionFolder, sessionId);
            
            // Read auth_info_multi.json
            const authInfoPath = path.join(sessionPath, "auth_info_multi.json");
            let sessionData = {};
            
            if (fs.existsSync(authInfoPath)) {
                sessionData = JSON.parse(fs.readFileSync(authInfoPath, "utf8"));
            } else {
                // Fallback: read all credential files
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
            
            return sessionData;
        } catch (error) {
            console.error("Error getting session data for WhatsApp:", error);
            return null;
        }
    }

    getPairingStatus(sessionId) {
        const pairing = this.activePairings.get(sessionId);
        if (!pairing) {
            return { 
                status: "not_found", 
                message: "Session expired or not found",
                error: "Session ID invalid"
            };
        }
        
        return {
            status: pairing.status,
            phoneNumber: pairing.phoneNumber,
            code: pairing.code,
            qr: pairing.qr,
            message: pairing.message || "Processing...",
            error: pairing.error || null,
            whatsappUserId: pairing.userId,
            sessionSent: pairing.sessionSent || false
        };
    }
    
    // Get QR code for a session
    getQRCode(sessionId) {
        const pairing = this.activePairings.get(sessionId);
        if (!pairing) {
            return null;
        }
        
        return pairing.qr;
    }

    saveSessionInfo(sessionId, phoneNumber, pairingCode, userId) {
        const filePath = path.join(this.sessionFolder, sessionId, "session-info.json");
        fs.ensureDirSync(path.dirname(filePath));
        
        const sessionInfo = {
            sessionId: sessionId,
            phoneNumber: phoneNumber,
            userId: userId,
            pairedAt: new Date().toISOString(),
            pairingCode: pairingCode,
            botName: "An0nOtF V3💎",
            developer: "Tylor (@unknownnumeralx)",
            channel: "@KenyaTechZone",
            generatedAt: new Date().toISOString(),
            sessionSentViaWhatsApp: true
        };
        
        fs.writeJsonSync(filePath, sessionInfo, { spaces: 2 });
        console.log("💾 Session info saved:", filePath);
    }
    
    cleanupSession(sessionId) {
        const pairing = this.activePairings.get(sessionId);
        if (pairing) {
            // Remove phone number lock
            if (this.phoneNumberLocks.get(pairing.phoneNumber) === sessionId) {
                this.phoneNumberLocks.delete(pairing.phoneNumber);
            }
            
            if (pairing.sock) {
                try {
                    pairing.sock.end();
                    pairing.sock.ws?.close();
                } catch (e) {}
            }
            
            // Remove from active pairings after a delay
            setTimeout(() => {
                this.activePairings.delete(sessionId);
            }, 5000);
        }
    }

    // Method to check if pairing is complete
    async checkPairingStatus(sessionId) {
        const pairing = this.activePairings.get(sessionId);
        if (!pairing) {
            return { status: "not_found", message: "Session not found" };
        }
        
        // Check if session files exist and have credentials
        const sessionPath = pairing.sessionPath;
        const authInfoPath = path.join(sessionPath, "auth_info_multi.json");
        
        if (fs.existsSync(authInfoPath)) {
            try {
                const authInfo = JSON.parse(fs.readFileSync(authInfoPath, "utf8"));
                if (authInfo.creds && authInfo.creds.me) {
                    return {
                        status: "ready",
                        message: "Session is ready to use!",
                        userId: authInfo.creds.me.id,
                        phoneNumber: pairing.phoneNumber,
                        sessionId: sessionId
                    };
                }
            } catch (e) {
                console.error("Error reading auth info:", e);
            }
        }
        
        return {
            status: pairing.status || "unknown",
            message: pairing.message || "Processing...",
            phoneNumber: pairing.phoneNumber,
            code: pairing.code,
            qr: pairing.qr,
            sessionId: sessionId
        };
    }
}

module.exports = new PairingManager();