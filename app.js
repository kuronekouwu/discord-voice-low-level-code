/**
 * Discord bot voice connection with low level code
 * 
 * HOW IT WORKS?
 * Discord voice is send RTP (Real-Time Protocol) packets. to able to play music,
 * we need to encrypt the voice packets with a secret key.
 * 
 * This code. I use source code from @discordjs/voice
 * 
 * IF YOU WANT TO READ FULL VOICE CONNECTION CODE, YOU CAN READ IN THIS LINK:
 * https://discord.com/developers/docs/topics/voice-connections
 */
const ws = require("ws");
const dgram = require("dgram");
const fs = require("fs");
const { pipeline } = require("stream");
const { opus, FFmpeg, VolumeTransformer } = require("prism-media");
const nacl = require("tweetnacl");
const { isIPv4 } = require("net");

const { randomNBit, logging } = require("./utils");

/**
 * Config:
 * - Token: Token discord bot
 * - Guild Id: Guild server
 * - Channel Id: Channel for to connect voice server
 */
const TOKEN = "ODAxMzY5NTIyOTA4OTU0NjU0.GkzULl.jfCnYp0aZVhrGvRhym2brFhrkm_Zz8GRDnC84s";
const GUILD_ID = "666457816176787466";
const CHANNEL_ID = "1014087472424161291";
const FILENAME = "./a.opus" // File to play (audio.opus is song PIKASONIC - Lost my mind)

// Voice config
const SHOW_PACKET_SEND = true;

// Websocket for gateway and voice server (DO NOT TOUCH)
/**
* @type {ws.WebSocket}
*/
let wssVC = null;
const wssDCGateway = new ws("wss://gateway.discord.gg/?v=9&encoding=json");

// UDP socket for voice server (DO NOT TOUCH)
const UDP = dgram.createSocket("udp4");

// CONFIG FOR BOT (DO NOT TOUCH)
let BOT_USER_ID = 0
let BOT_USER_SESSION_ID = "";

// CONFIG FOR VOICE SERVER (DO NOT TOUCH)
let IP_VOICE_SERVER = "";
let PORT_VOICE_SERVER = 0;
let SSRC = 0;

// CONFIG FOR LOCAL TO ADD ACCESS TO SEND UDP PACKETS
let IP_NETWORK = "";
let PORT_NETWORK = 0

// CONFIG FOR VOICE ENCRYPTION (DO NOT TOUCH)
let SEQ = -1
let TIMESTAMP = -1

// OTHER FOR HANDLER WEBOSCKET
let intervalDCGateway = null;
let intervalVoiceServer = null;

// AUDIO PLAYER (DO NOT TOUCH)
let IS_PLAYING = false;

// Event of connect (Discord gateway)
wssDCGateway.on("open", () => {
    logging("Discord Gateway", "Connected to gateway");
})

/// Event of disconnect (Discord gateway)
wssDCGateway.on("close", () => {
    logging("Discord Gateway", "Disconnected from discord gateway");
})

// Event of message (Discord gateway)
wssDCGateway.on("message", (data) => {
    /**
     * Parse date to json
     * - op (Opcode)
     * - d (Data)
    */
    const messageDiscord = JSON.parse(data);

    /**
     * Check op code:
     * I use op code for voice connection
     * - 10 -> Hello (Wait for identify) [Recieve]
     * - 2 -> Identify (Send token) [Send]
     * - 0 -> Response (Login success) [Recieve]
     */
     switch (messageDiscord.op) {
        case 0:
            // Check if data is ready
            switch(messageDiscord.t) {
                case "READY":
                    BOT_USER_ID = messageDiscord.d.user.id;
                    BOT_USER_SESSION_ID = messageDiscord.d.session_id;
                    logging("Discord Gateway", `${messageDiscord.d.user.username} has connected to discord`);
                    logging("Discord Gateway", `Join voice channel: ${CHANNEL_ID}`);
                    wssDCGateway.send(
                        JSON.stringify({
                            op: 4,
                            d: {
                                guild_id: GUILD_ID,
                                channel_id: CHANNEL_ID,
                                self_mute: false,
                                self_deaf: true,
                            },
                        })
                    );

                    break;
                case "VOICE_SERVER_UPDATE":
                    // Check if interval is not null
                    if(!intervalDCGateway && !wssVC){
                        // Clear interval
                        clearInterval(intervalDCGateway)
                        // close websocket voice connection
                        wssVC?.close();
                        break;
                    }

                    // Connect to voice server
                    wssVC = new ws(`wss://${messageDiscord.d.endpoint}/?v=4`);

                    wssVC.on("open", () => {
                        logging("Discord voice server", `Connected to voice server endpoint: ${messageDiscord.d.endpoint}`);
                    })
                    wssVC.on("close", () => {
                        // Clear interval
                        clearInterval(intervalDCGateway)
                        logging("Discord voice server", `Disconnected from voice server endpoint: ${messageDiscord.d.endpoint}`);
                    })
                    wssVC.on("message", (data) => {
                        // Prase to json
                        const messageVC = JSON.parse(data);

                        /**
                         * Check op code for voice server:
                         * - 8 -> Hello (Wait for identify) [Recieve]
                         * - 0 -> Identify (Send user id, session id and token) [Send]
                         * - 2 -> Response (Login success) [Recieve]
                         * - 1 -> Select protocol (Send protocol) [Send]
                         * - 4 -> Ready (Send SSRC) [Recieve]
                         */
                        switch (messageVC.op) {
                            case 8: // Hello
                                // Create interval for voice server
                                intervalVoiceServer = setInterval(() => {
                                    wssVC.send(
                                        JSON.stringify({
                                            op: 3,
                                            d: Date.now(),
                                        })
                                    );
                                }, messageVC.d.heartbeat_interval);

                                // Send identify
                                wssVC.send(
                                    JSON.stringify({
                                        op: 0,
                                        d: {
                                            server_id: GUILD_ID, // OR GUILD_ID from config
                                            user_id: BOT_USER_ID,
                                            session_id: BOT_USER_SESSION_ID,
                                            token: messageDiscord.d.token,
                                        }
                                    })
                                )
                                break;
                            case 2: // Response
                                // Set IP, PORT and SSRC
                                IP_VOICE_SERVER = messageVC.d.ip;
                                PORT_VOICE_SERVER = messageVC.d.port;
                                SSRC = messageVC.d.ssrc;

                                logging("Discord voice server", `Joined to voice server with IP: ${IP_VOICE_SERVER}:${PORT_VOICE_SERVER}`);

                                /**
                                 * Create buffer for request IP
                                 * https://discord.com/developers/docs/topics/voice-connections#ip-discovery
                                 */
                                const ipDiscoveryBuffer = Buffer.alloc(74);
                                ipDiscoveryBuffer.writeUInt16BE(1, 0); // Type (0x1)
                                ipDiscoveryBuffer.writeUInt16BE(70, 2); // Length (0x46)
                                ipDiscoveryBuffer.writeUInt32BE(SSRC, 4); // SSRC
                                
                                // Event message of UDP
                                UDP.once("message", (msg) => {
                                    // Check if alerdy have IP
                                    if(IP_NETWORK !== "") return;
                                    
                                    // Parse buffer
                                    const packet = Buffer.from(msg);

                                    // Get IP and check if is valid
                                    IP_NETWORK = packet.slice(8, packet.indexOf(0, 8)).toString('utf-8');
                                    if(!isIPv4(IP_NETWORK)) throw new Error("Invalid IP");

                                    // Get PORT
                                    PORT_NETWORK = packet.readUInt16BE(packet.length - 2);

                                    // Send protocol to send package
                                    logging("Discord voice server", `Select protocol UDP over IP: ${IP_NETWORK}:${PORT_NETWORK}`);
                                    wssVC.send(
                                        JSON.stringify({
                                            op: 1,
                                            d: {
                                                protocol: "udp",
                                                data: {
                                                    address: IP_NETWORK,
                                                    port: PORT_NETWORK,
                                                    mode: "xsalsa20_poly1305",
                                                }
                                            }
                                        })
                                    )
                                })
                                // Send request UDP
                                UDP.send(ipDiscoveryBuffer, PORT_VOICE_SERVER, IP_VOICE_SERVER);
                                break;
                            case 4: // Ready
                                if(IS_PLAYING) break;

                                // Keep SECRET_KEY for voice encryption
                                const SECRET_KEY = messageVC.d.secret_key;

                                // Send voice server to speak
                                logging("Discord voice server", `Send voice server to speak`);
                                wssVC.send(
                                    JSON.stringify({
                                        op: 5,
                                        d: {
                                            speaking: 1,
                                            delay: 0,
                                        }
                                    })
                                )

                                if(!IS_PLAYING){
                                    /**
                                     * Create pipeline
                                     * 1. CreateReadStream (Read file)
                                     * 2. Convert audio to Opus (FFMPEG)
                                     * 3. Demux Audio (Opus)
                                     */
                                    logging("pipeline", `Pepareing pipeline`);
                                    const convertOpusPipe = pipeline([
                                        fs.createReadStream(FILENAME),
                                        // new FFmpeg({
                                        //     args: [
                                        //         "-i",
                                        //         "-",
                                        //         "-analyzeduration",
                                        //         "0",
                                        //         "-loglevel",
                                        //         "0",
                                        //         // "-acodec",
                                        //         // "libopus",
                                        //         "-f",
                                        //         "s16le",
                                        //         "-ar",
                                        //         "48000",
                                        //         "-ac",
                                        //         "2"
                                        //     ]
                                        // }),
                                        new opus.OggDemuxer(),
                                        // new VolumeTransformer({
                                        //     type: "s16le",
                                        //     volume: 0.1
                                        // }),
                                        // new opus.Encoder({
                                        //     channels: 2,
                                        //     rate: 48000,
                                        //     frameSize: 960,
                                        // })
                                    ], () => {})
                                    
                                    // Event if data is readable
                                    convertOpusPipe.once("readable", async () => {
                                        logging("pipeline", `Playing audio`);

                                        // Set is playing music
                                        IS_PLAYING = true;
                                        // Set NEXTTIME variable for slow to send packet audio
                                        let NEXTTIME = Date.now();

                                        // Create sequence number and timestamp
                                        SEQ = randomNBit(16); // 16 bit = 2 byte
                                        TIMESTAMP = randomNBit(32) // 32 bit = 4 byte

                                        while(true){
                                            // Get read data
                                            const opusPacket = convertOpusPipe.read();

                                            // Check if opusPacket is null (Audio is end)
                                            if(!opusPacket){
                                                IS_PLAYING = false;
                                                break;
                                            };
                                            
                                            // Create buffer header and nonce
                                            const header = Buffer.alloc(12); // 12 bytes
                                            const nonce = Buffer.alloc(24); // 24 bytes

                                            // Set header
                                            header[0] = 0x80 // Type (0x80)
                                            header[1] = 0x78 // Payload Type (0x78)

                                            header.writeUIntBE(SEQ, 2, 2);
                                            header.writeUIntBE(TIMESTAMP, 4, 4);
                                            header.writeUIntBE(SSRC, 8, 4);

                                            // Plus sequence number and timestamp
                                            SEQ += 1;
                                            TIMESTAMP += (48000 / 100) * 2; // (48kHz / 100ms) * 2channel = 960

                                            // Check if is over buffer bitrate (Sequence number (16 bits)), (Timestamp (32 bits))
                                            if(SEQ >= 2 ** 16){ // 2 ** 16 = 65536
                                                // Reset sequence number
                                                SEQ = 0;
                                            }
                                            if(TIMESTAMP >=  2 ** 32) { // 2 ** 32 = 4294967296
                                                // Reset timestamp
                                                TIMESTAMP = 0;
                                            }

                                            // Copy header to nonce
                                            header.copy(nonce, 0, 0, 12);

                                            // Encript audio
                                            const packet = Buffer.concat([
                                                header, 
                                                nacl.secretbox(opusPacket, nonce, new Uint8Array(SECRET_KEY)), // Audio, nonce, secret_key
                                            ])
                                            
                                            if(SHOW_PACKET_SEND) logging("UDP", `Sending audio packet with size: ${packet.length}`);

                                            // Send packet audio
                                            UDP.send(packet, 0, packet.length, PORT_VOICE_SERVER, IP_VOICE_SERVER, (err) => {
                                                if(err) logging("UDP", `Oh s**t. Lose audio packet with sequence number: ${SEQ} and timestamp: ${TIMESTAMP}`);
                                            });

                                            // Delay 
                                            NEXTTIME += 20 // 20ms
                                            await new Promise(r => setTimeout(r, NEXTTIME - Date.now()))
                                        }

                                        // Send voice server to stop speak
                                        logging("Discord voice server", `Send voice server to stop speak`);
                                        wssVC.send(
                                            JSON.stringify({
                                                op: 5,
                                                d: {
                                                    speaking: 0,
                                                    delay: 0,
                                                }
                                            })
                                        )

                                        // Disconnect voice server
                                        clearInterval(intervalVoiceServer)
                                        intervalVoiceServer.close()
                                        wssVC.close()
                                    })
                                }
                                break;
                        }
                    })

                    break;
            }
            break;
        case 10:
            // Set interval of discord gateway
            intervalDCGateway = setInterval(() => {
                // Send heartbeat
                wssDCGateway.send(JSON.stringify({
                    op: 1,
                    d: Date.now(),
                }));
            }, messageDiscord.d.heartbeat_interval);
            // Indentify
            wssDCGateway.send(
                JSON.stringify({
                    op: 2,
                    d: {
                        token: TOKEN,
                        intents: 512,
                        properties: {
                            $os: "windows",
                            $browser: "discordJS",
                            $device: "discordJS",
                        },
                    },
                })
            );
            break;
     }
})

process.on("SIGINT", () => {
    logging("process", `Exit process`);
    process.exit(1)
})