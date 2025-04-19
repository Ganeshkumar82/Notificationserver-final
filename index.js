const { app, BrowserWindow, Tray, Menu,dialog} = require('electron');
app.disableHardwareAcceleration();
const { createLogger, transports, format } = require('winston');
const { combine, timestamp, printf } = format;
const path = require('path');
const net = require('net');
const WebSocket = require('ws');
const userauth = require('./services/userauth');
const config = require('./config1');
const db = require('./services/db');
const express = require('express');
const os = require('os');
let mainWindow;
let tray;
var dataInterval;
let isAppRunning = false;
const connectedUsers = new Map();
const NodeCache = require('node-cache');
const processedEvents = new NodeCache({ stdTTL: 600 }); 
const processedImage = new NodeCache({ stdTTL: 600 });
const connectedTcpClients = [];
const imageProcessingQueue = [];
const apiapp= express();
const eventLocks = new Set();
const port = config.endpointport; 
const logger = createLogger({
    format: combine(
        timestamp(),
        printf(({ level, message, timestamp }) => {
            return `${timestamp} [${level.toUpperCase()}]: ${message}`;
        })
    ),
    transports: [
        // new transports.Console(), // Log to console
        new transports.File({ filename: '.\\notificationservererrorlog\\error.txt' }) 
    ]
});


// Fetch image paths from Redis in batches
async function fetchImagePathsBatch(count = 32) {
    try {
        const imagePaths = await db.redis.lrange('imagePaths', -count, -1); // Get the last 'count' items
        if (imagePaths.length > 0) {
            await db.redis.ltrim('imagePaths', 0, -(count + 1)); // Remove the fetched items from the list
        }
        return imagePaths;
    } catch (error) {
        console.error("Error fetching image paths from Redis:", error);
        return [];
    }
}

apiapp.get('/status',async (req,res) => {
    try{
        res.json({ isAppRunning });
    }catch(er){
        res.status(500).json({ error: error.message });
    }
});

apiapp.get('/quit',async (req,res) => {
    try{
        quitApplication();
        res.status(200).json({code :true, message: "Application stopped" });
    }catch(er){
        res.status(500).json({ code :false,error: error.message });
    }
});

// Add a restart route to the Express API
apiapp.get('/restart', async (req, res) => {
    try {
        restartApplication();
        res.status(200).json({ code :true,message: 'Application restarted' });
    } catch (error) {
        logger.error('Error restarting application:', error);
        res.status(500).json({ code :false,error: 'Error restarting application' });
    }
});

apiapp.get('/connectedusers', async (req, res) => {
    try {
        const connectedUserDetails = await connectedusers();
        res.json({ connectedUsers: connectedUserDetails });
    } catch (error) {
        
        console.error('Error fetching connected users:', error);
        res.status(500).json({ error: 'Error fetching connected users' });
    }
});


async function connectedusers() {
    // Get user details directly from the connectedUsers map without querying the database
    const connectedUserDetails = Array.from(connectedUsers.values()).reduce((acc, user) => {
        acc[user.userId] = user.username; // Fetch the username directly from the map
        return acc;
    }, {});

    console.log('Connected Users Details:', connectedUserDetails);
    return connectedUserDetails;
}

// Endpoint to get number of events for each user
apiapp.get('/userevents', async (req, res) => {
    try {
        const userEvents = await getUserEventsFromDatabase(); // Implement this function
        res.json(userEvents);
    } catch (error) {
        logger.error('Error fetching user events:', error);
        res.status(500).json({ error: 'Error fetching user events' });
    }
});

// Endpoint to update active event count for a user
apiapp.post('/updateactiveevents', async (req, res) => {
    const { userId, activeevents } = req.body; // Assuming client sends userId and activeEvents in the request body

    try {
        await updateActiveEventsInDatabase(userId, activeevents); // Implement this function
        res.status(200).json({ message: 'Active events updated successfully' });
    } catch (error) {
        logger.error('Error updating active events:', error);
        res.status(500).json({ error: 'Error updating active events' });
    }
});


// Start the Express server
const server = apiapp.listen(port, () => {
    logger.info(`Express server running on port ${port}`);
});

app.setName('svmnotificationserver');

app.on('ready', async () => {
    createWindow();
    await startNotificationServer();
});

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1195,
        height: 518,
        show: true,
        center: true,
        resizable: false,
        movable: false,
        minimizable: true,
        maximizable: false,
        fullscreenable: false,
        frame: false,
        alwaysOnTop: true,
        enableBlinkFeatures: false,
        webgl: false,
        icon: path.join(__dirname, './noticonnect.ico'),
        backgroundColor: '#F0F0F0',
        transparent: true,
    });

    // mainWindow.loadFile('index.html');
    mainWindow.loadFile('index.html');
    mainWindow.setTitle('SVM Notification Server.');

   // Set a timeout to simulate the start-up process
   setTimeout(() => {
    // Once the TCP socket and WebSocket are started, update the content
    mainWindow.loadFile('index.html');
    // Hide the main window after some time (adjust the delay as needed)
          mainWindow.hide();
          mainWindow = null; // Adjust the delay as needed
     }, 3000); 
     
    mainWindow.on('closed', () => {
        isAppRunning = false;
        mainWindow = null;
        quitApplication(); // Call quitApplication when mainWindow is closed
    });
    isAppRunning = true;

 
    app.whenReady().then(() => {
    tray = new Tray(path.join(__dirname, './noticonnect.ico'));
    const contextMenu = Menu.buildFromTemplate([
       
        { label: 'Connected Users', click: async () => {
            const users = await connectedusers();
            const usersString = JSON.stringify(users, null, 2);
            // Show a dialog with the return value of connectedUsers function
            dialog.showMessageBox({
                type: 'info',
                title: 'Connected Users',
                message: usersString,
            });
        }},
        // { type: 'separator' },
        // { label: 'Users List',click: () => createMainWindow() },
        { type: 'separator' },
        { label: 'Restart',click: () => restartApplication() },
        { type: 'separator' },
        { label: 'Quit', click: () => quitApplication() }
    ]);
    tray.setToolTip('NOTIFICATION SERVER');
    tray.setContextMenu(contextMenu);
});
}
function getIPAddress() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return '0.0.0.0'; // Default if no external IP is found
}

async function startNotificationServer() {
      const ipaddress = getIPAddress();
      console.log(`(IPADDRESS -> ${ipaddress}`);
      updateServerSettings(ipaddress,1);
    //   console.log(imageProcessingQueue.length);
      const tcpServer = net.createServer((socket) => {
        logger.info('TCP client connected');
        // socket.write('<Success>');
        connectedTcpClients.push(socket); // Add TCP client to the list
        socket.on('data', async (data) => {
            const message = data.toString('utf8').trim();
            console.log(message);
            if (message.startsWith('<ClientLogin>')) {
                // Handle client login
                const match = message.match(/<ClientLogin>(.*),(.*),(.*)/);
                if (match) {
                    
                    const userId = match[2]; // Extract userId from the message
                    const custId = match[1]; // Extract custId from the message
                    const permission = match[3];
    
                    try {
                        // const user = await userauth.authenticateUser(userId, custId);
                        const userChannel = await userauth.getUserFromDatabase(userId);
    
                        if (userChannel && userChannel.User_Type == config.user_channel) {
                            connectedUsers.set(userId, { userId, username: userChannel.username, socket });
                            const remoteEndpoint = `${socket.remoteAddress}:${socket.remotePort}`;
                            let ipv4Address = remoteEndpoint;
                            console.log(` remoteEndpoint address ${remoteEndpoint}`);
                            // Check if it's an IPv6-mapped IPv4 address
                            if (remoteEndpoint.includes('::ffff:')) {
                            ipv4Address = remoteEndpoint.split('::ffff:')[1];
                              }
                            console.log(` ipv4 address ${ipv4Address}`);
                            await addonlineuser(userId,ipv4Address);
                            socket.write('<Success>');
                            startDataSending(userId, socket);
                        } else {
                            handleTcpClientDisconnect(socket); 
                            socket.write('User not allowed.\n');
                        }
                    } catch (error) {
                        socket.write('Authentication failed: ' + error.message + '\n');
                        logger.error('Authentication failed: ' + error.message + '\n');
                    }
                }

            }
            if(message.startsWith('<serverstatus>')){
                ws.write('<success>');
            }
            if(message.startsWith('<addmessage>')){
                console.log(message);
                const match = message.match(/<addmessage>([\s\S]*?)~(\d+)~([\s\S]*?)<\/addmessage>/);
                const messagelog = match[1].trim();
                const userid = match[2].trim();
                const username = match[3].trim();
                await SendMessage(messagelog,userid,username);
            }
            if(message.startsWith('<breakrequest>')){
                console.log(message);
                const match = message.match(/<breakrequest>(.*),(.*),(.*),(.*)/);
                if(match){
                    const breakUserId = match[1].trim();
                    const RequestUserId = match[2].trim();
                    const groupid = match[3].trim();
                    const breakReason = match[4].trim();
                    // Check if the user is connected 
                    const user = connectedUsers.get(breakUserId);
                    const user1 = connectedUsers.get(RequestUserId);
                    if (user && user.socket && user1.username) {
                        // Send data back to the user who sent the break request
                        if (user.socket instanceof WebSocket && user.socket.readyState === WebSocket.OPEN) {
                           user.socket.send(`<apporvebreak>${RequestUserId},${user1.username},${groupid}</apporvebreak>`);

                       } else if (user.socket instanceof net.Socket && !user.socket.destroyed) {
                           user.socket.write(`<apporvebreak>${RequestUserId},${user1.username},${groupid}</apporvebreak>`);
                
                       }
                // user.socket.send('Break request received.');
                console.log(`Sent break request confirmation to userId: ${breakUserId} by User ${RequestUserId}`);
            } else {
                console.log(`User with userId ${breakUserId} is not connected.`);
                ws.send('<NotConnected>');
            }
                }
            }
            if(message.startsWith(`<response>`)){
                const match = message.match(/<response>(\d+),(\d+),(.+),(.+)<\/response>/);
                if (match) {
                  const senduser = match[1].trim();   // First number
                  const Receiveduserid = match[2].trim();  // Second number
                  const response = match[3].trim();  
                  const groupid = match[4].trim();
                  const user = connectedUsers.get(senduser);
                  const user1 = connectedUsers.get(Receiveduserid);
                    if (user && user.socket && user1.username) {
                        // Send data back to the user who sent the break request
                        if (user.socket instanceof WebSocket && user.socket.readyState === WebSocket.OPEN) {
                            user.socket.send(`<apporvebreak>${Receiveduserid},${user1.username},${response}</apporvebreak>`);
                            if(response == 'Yes'){
                                user.socket.close();
                                connectedUsers.delete(senduser);
                            }
                        } else if (user.socket instanceof net.Socket && !user.socket.destroyed) {
                            user.socket.write(`<apporvebreak>${Receiveduserid},${user1.username},${response}</apporvebreak>`);
                            if(response == 'Yes'){
                                user.socket.end();
                                connectedUsers.delete(senduser);
                            }
                        } else {
                            console.error("Socket is not available or closed.");
                            return;
                        }
                    
                        // Insert data into the database (using parameterized query for safety)
                        try {
                            if(response == 'Yes'){
                            await db.query(
                                `INSERT INTO usersbreak (username, user_id, Assigned_userid, Group_id) VALUES (?, ?, ?, ?)`,
                                [user.username, senduser, Receiveduserid,groupid]
                            );
                        }
                        } catch (error) {
                            console.error("Error inserting into database:", error.message);
                        }
                // ws.send('Break request Send.');
                console.log(`Sent break request confirmation to userId: ${Receiveduserid}`);
            } else {
                console.log(`User with userId ${breakUserId} is not connected.`);
                ws.send('<NotConnected>');
            } 
        }      
    }
            if(message.startsWith('<Exit>')){
                logger.info('Client disconnected');
                handleTcpClientDisconnect(socket);
            }
        });
    
        socket.on('error', (error) => {
            if (error.code === 'EADDRINUSE') {
                logger.error('Port 55555 is already in use by another application.');
                app.quit();
              }
            logger.error('TCP socket error:', error.message);
            handleTcpClientDisconnect(socket, error); // Handle TCP socket errors
        });
    
        socket.on('end', () => {
            logger.info('TCP client disconnected');
            handleTcpClientDisconnect(socket); // Handle TCP client disconnection
        });
    });
    
    tcpServer.listen(config.tcpport, () => {
        logger.info(`TCP server running on port ${config.tcpport}`);
    });
   
    const wss = new WebSocket.Server({port: config.notificationport });
  
    wss.on('connection', function connection(ws) {
        logger.info('Client connected');
        let userId; // Define userId variable in the scope of the connection event listener
        let custId; 
        const remoteEndpoint = `${ws._socket.remoteAddress}:${ws._socket.remotePort}`;
        let ipv4Address = remoteEndpoint;
        console.log(` remoteEndpoint address ${remoteEndpoint}`);
        // Check if it's an IPv6-mapped IPv4 address
        if (remoteEndpoint.includes('::ffff:')) {
          ipv4Address = remoteEndpoint.split('::ffff:')[1];
         }
         console.log(` ipv4Address address ${ipv4Address}`);

        ws.on('message', async function incoming(message) {
            message = message.toString('utf8').trim();
            console.log('Received message:', message);

            if (message.startsWith('<ClientLogin>')) {
                console.log();
                const match = message.match(/<ClientLogin>(.*),(.*),(.*)/);
                if (match) {
                    custId = match[1]; // Set userId when client logs in
                    userId = match[2];
                    const permission = match[3];
                    console.log(`userid -> ${userId} custid -> ${custId}`);
                    try {
                        const userChannel = await userauth.getUserFromDatabase(userId);
                        if (userChannel && userChannel.User_Type == config.user_channel) {
                            ws.send('<Success>');
                            connectedUsers.set(userId, { userId, username: userChannel.username, socket: ws });
                            await addonlineuser(userId,ipv4Address);
                            ws.userId = userId; 
                            console.log(`userid -> ${userId} custid -> ${custId}`);
                            // Start sending data to the user
                            startDataSending(userId, ws);
                        } else {
                            ws.send('User not allowed.');
                        }
                    } catch (error) {
                        ws.send('Authentication failed: ' + error.message);
                    }
                }
            }
            if(message.startsWith('<serverstatus>')){
                console.log(message);
                ws.send('<success>');
            }
            if(message.startsWith('<addmessage>')){
                // console.log(message);
                const match = message.match(/<addmessage>(.*)~(\d+)~(.*)<\/addmessage>/);
                const messagelog = match[1].trim();
                const userid = match[2].trim();
                const username = match[3].trim();
                await SendMessage(messagelog,userid,username);
            }
            if(message.startsWith('<breakrequest>')){
                console.log(message);
                const match = message.match(/<breakrequest>(.*),(.*),(.*),(.*)/);
                if(match){
                    const breakUserId = match[1].trim();
                    const RequestUserId = match[2].trim();
                    const groupid = match[3].trim();
                    const breakReason = match[4].trim();
                    const user = connectedUsers.get(breakUserId);
                    const user1 = connectedUsers.get(RequestUserId);
                    if(breakReason == 'Dinner'){
                        const sql1 = await db.query(`select break_id from usersbreak where break_reason = 'Dinner' and user_id = ${RequestUserId};`);
                        if(sql1.length > 0){
                            if (user1.socket instanceof WebSocket && user1.socket.readyState === WebSocket.OPEN) {
                                user1.socket.send(`<apporvebreak>${RequestUserId},${user1.username},false</apporvebreak>`); 
                                
                            }
                         else if (user1.socket instanceof net.Socket && !user.socket.destroyed) {
                            user1.socket.write(`<apporvebreak>${RequestUserId},${user1.username},false</apporvebreak>`);
                         }
                        }else{
                            if (user && user.socket && user1.username) {
                                // Send data back to the user who sent the break request
                                if (user.socket instanceof WebSocket && user.socket.readyState === WebSocket.OPEN) {
                                   user.socket.send(`<apporvebreak>${RequestUserId},${user1.username},${groupid},${breakReason}</apporvebreak>`);
                                //    await db.query(`Insert into usersbreak(username,user_id,Assigned_userid) VALUES('${user1.username}',${RequestUserId},${breakUserId})`);
                                //    await connectedUsers.delete(breakUserId);
                                //    user.socket.close();
                               } else if (user.socket instanceof net.Socket && !user.socket.destroyed) {
                                   user.socket.write(`<apporvebreak>${RequestUserId},${user1.username},${groupid},${breakReason}</apporvebreak>`);
                                //    await connectedUsers.delete(breakUserId);
                                //    user.socket.end();
                               }
                            
                        // ws.send('Break request Send.');
                        console.log(`Sent break request confirmation to userId: ${breakUserId}`);
                            
                    } else {
                        console.log(`User with userId ${breakUserId} is not connected.`);
                        ws.send('<NotConnected>');
                    }
                 }
            }else{
                if (user && user.socket && user1.username) {
                    // Send data back to the user who sent the break request
                    if (user.socket instanceof WebSocket && user.socket.readyState === WebSocket.OPEN) {
                       user.socket.send(`<apporvebreak>${RequestUserId},${user1.username},${groupid},${breakReason}</apporvebreak>`);
                   } else if (user.socket instanceof net.Socket && !user.socket.destroyed) {
                       user.socket.write(`<apporvebreak>${RequestUserId},${user1.username},${groupid},${breakReason}</apporvebreak>`);
                   }
                
            // ws.send('Break request Send.');
            console.log(`Sent break request confirmation to userId: ${breakUserId}`);
                
        } else {
            console.log(`User with userId ${breakUserId} is not connected.`);
            ws.send('<NotConnected>');
        }
            }
                    
                    
       }  }
       if(message.startsWith('<breakfinishedrequest>')){
        const match = message.match(/<breakfinishedrequest>(.*),(.*),(.*)<\/breakfinishedrequest>/);
        const match1 = message.match(/<breakfinishedrequest>(.*),(.*)<\/breakfinishedrequest>/);
        if(match){
            const RequestUserId = match[1].trim();
            const breakUserId = match[2].trim();
            const group = match[3].trim() || 0;
            const user = connectedUsers.get(RequestUserId);
            const user1 = connectedUsers.get(breakUserId);
            if (user && user.socket && user1.username) {
                if (user.socket instanceof WebSocket && user.socket.readyState === WebSocket.OPEN) {
                    user.socket.send(`<breakfinished>${breakUserId},${user1.username},${group}</breakfinished>`);
                   
                } else if (user.socket instanceof net.Socket && !user.socket.destroyed) {
                    user.socket.write(`<breakfinished>${breakUserId},${user1.username},${group}</breakfinished>`);
            }
         }
        }
        if(match1){
            const RequestUserId = match1[1].trim();
            const breakUserId = match1[2].trim();
            const user = connectedUsers.get(RequestUserId);
            const user1 = connectedUsers.get(breakUserId);
            if (user && user.socket && user1.username) {
                if (user.socket instanceof WebSocket && user.socket.readyState === WebSocket.OPEN) {
                    user.socket.send(`<breakfinished>${breakUserId},${user1.username}</breakfinished>`);
                   
                } else if (user.socket instanceof net.Socket && !user.socket.destroyed) {
                    user.socket.write(`<breakfinished>${breakUserId},${user1.username}</breakfinished>`);
            }
         }
        }
       }
            if(message.startsWith(`<response>`)){
                const match = message.match(/<response>(\d+),(\d+),(.+),(.+),(.+)<\/response>/);
                if (match) {
                  const senduser = match[1].trim();   // First number
                  const Receiveduserid = match[2].trim();  // Second number
                  const response = match[3].trim();  
                  const groupid = match[4].trim();
                  const breakreason = match[5].trim();
                  const user = connectedUsers.get(senduser);
                  const user1 = connectedUsers.get(Receiveduserid);
                    if (user && user.socket && user1.username) {
                        // Send data back to the user who sent the break request
                        if (user.socket instanceof WebSocket && user.socket.readyState === WebSocket.OPEN) {
                            user.socket.send(`<apporvebreak>${Receiveduserid},${user1.username},${response},${groupid}</apporvebreak>`);
                            if(response == 'Yes'){
                                user.socket.close();
                                connectedUsers.delete(senduser);
                            }
                        } else if (user.socket instanceof net.Socket && !user.socket.destroyed) {
                            user.socket.write(`<apporvebreak>${Receiveduserid},${user1.username},${response},${groupid}</apporvebreak>`);
                            if(response == 'Yes'){
                                user.socket.end();
                                connectedUsers.delete(senduser);
                            }
                        } else {
                            console.error("Socket is not available or closed.");
                            return;
                        }
                    
                        // Insert data into the database (using parameterized query for safety)
                        try {
                            if(response == 'Yes'){
                            await db.query(
                                `INSERT INTO usersbreak (username, user_id, Assigned_userid, Group_id,break_reason) VALUES (?, ?, ?, ?,?)`,
                                [user.username, senduser, Receiveduserid,groupid,breakreason]
                            );
                        }
                        } catch (error) {
                            console.error("Error inserting into database:", error.message);
                        }
                // ws.send('Break request Send.');
                console.log(`Sent break request confirmation to userId: ${Receiveduserid}`);
            } else {
                console.log(`User with userId ${breakUserId} is not connected.`);
                ws.send('<NotConnected>');
            } 
        }      
    }
            if(message.startsWith('<Exit>')){
                logger.info('Client disconnected'+userId);
                console.log('Client disconnected'+userId);
                connectedUsers.delete(userId); 
                stopDataSending(userId);
                const remoteEndpoint = `${ws._socket.remoteAddress}:${ws._socket.remotePort}`;
                let ipv4Address = remoteEndpoint;
                // Check if it's an IPv6-mapped IPv4 address
                if (remoteEndpoint.includes('::ffff:')) {
                      ipv4Address = remoteEndpoint.split('::ffff:')[1];
                }
                    console.log(ipv4Address);
                UpdateOnlineUser(userId,ipv4Address);
            }
        });

        ws.on('close', function close() {
            logger.info('Client disconnected'+userId);
            console.log('Client disconnected'+userId);
            connectedUsers.delete(userId); 
            stopDataSending(userId);
            const remoteEndpoint = `${ws._socket.remoteAddress}:${ws._socket.remotePort}`;
            let ipv4Address = remoteEndpoint;
            console.log(` remoteEndpoint address ${remoteEndpoint}`);
            // Check if it's an IPv6-mapped IPv4 address
            if (remoteEndpoint.includes('::ffff:')) {
                  ipv4Address = remoteEndpoint.split('::ffff:')[1];
            }
            console.log(` ipv4Address address ${ipv4Address}`);
            UpdateOnlineUser(userId,ipv4Address);
        });
    });      
     console.log(`Web Socket server listening on port 55566`);
    logger.info(`Web Socket server listening on port 55566`);
}


async function addonlineuser(userid, remoteip){
  try{
    console.log(`userid ${userid}  remoteip ${remoteip}`);
    let [sql] = await db.spcall(`CALL AddOnlineUser(?,?)`,[userid,remoteip]);
  }catch(er){
    logger.error(`onlineusererror -> ${er}`);
  }
}

async function UpdateOnlineUser(userid, remoteip){
    try{
        console.log(`UpdateOnlineUser ${userid}  remoteip ${remoteip}`);
      let [sql] = await db.spcall(`CALL UpdateOnlineUser(?,?)`,[userid,remoteip]);
    }catch(er){
      logger.error(`onlineusererror -> ${er}`);
    }
  }
async function handleTcpClientDisconnect(socket) {
    try{
    const remoteEndpoint = `${socket.remoteAddress}:${socket.remotePort}`;
    let ipv4Address = remoteEndpoint;
    // Check if it's an IPv6-mapped IPv4 address
    if (remoteEndpoint.includes('::ffff:')) {
          ipv4Address = remoteEndpoint.split('::ffff:')[1];
    }
        console.log(ipv4Address);
    const userId = getUserIdFromSocket(socket); // Get userId from the socket if available
    if (userId) {
        connectedUsers.delete(userId);
        stopDataSending(userId);
        await UpdateOnlineUser(userId,ipv4Address);
        console.log(`User ${userId} disconnected`);
    }

    const index = connectedTcpClients.indexOf(socket);
    if (index !== -1) {
        connectedTcpClients.splice(index, 1);
    }
}catch(er){
    logger.error(`connection -> ${er}`);
}
}

function getUserIdFromSocket(socket) {
    for (const [userId, { username, socket: userSocket }] of connectedUsers) {
        if (userSocket === socket) {
            console.log(`Found userId ${userId}, username ${username} for socket`);
            return userId; // Return both userId and username
        }
    }
    console.log('No user found for the given socket');
    return null; // No user found for the given socket
}

// Function to fetch number of events for each user from the database
async function getUserEventsFromDatabase() {
    // Implement your database query to get the number of events for each user
    const sql = `SELECT user_id, COUNT(Event_id) AS numEvents FROM eventuser GROUP BY user_id`;
    const rows = await db.query(sql);
    const userEvents = rows.reduce((acc, row) => {
        acc[row.user_id] = row.numEvents;
        return acc;
    }, {});
    return userEvents;
}

async function updateServerSettings(sname,svalue) {
    try {
        // Call the stored procedure to update server settings
        const result = await db.spcall('CALL setserversettings(?, ?)', [sname,svalue]);
        
        // Check the result to ensure the stored procedure executed successfully
        if (result && result.length > 0) {
            logger.info('Server settings updated successfully:');
        } else {
            logger.error('Error updating server settings:');
        }
    } catch (err) {
        logger.error('Error updating server settings:', err);
    }
}

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        quitApplication(); // Call quitApplication when all windows are closed
    }
});

app.on('activate', () => {
    if (mainWindow === null) {
        createWindow();
    }
});

function restartApplication() {
    console.log(imageProcessingQueue.length);
    clearProcessedImage();
    clearProcessedEvents();
    app.relaunch();
    app.exit(0); 
}

function quitApplication() {
    // Delete processed files and stop data sending when quitting
    console.log(imageProcessingQueue.length);
    clearProcessedImage();
    clearProcessedEvents();
    const ipaddress = getIPAddress();
    updateServerSettings(ipaddress,0);
    stopDataSending();
    if (mainWindow) {
        mainWindow.destroy();
    }
    app.quit();
}

process.on('SIGINT', () => {
    quitApplication();
});

process.on('SIGTERM', () => {
    quitApplication();
});


async function extractEventAndCameraIds(imagePath) {
    // console.log(`imagepath -> ${imagePath}`);
    const parts = imagePath.split(path.sep);
    // console.log(`parts -> ${parts}`);
    const eventPart = parts.find(part => part.startsWith('Event'));
    const camPart = parts.find(part => part.match(/cam\d+/i)); // Match cam followed by digits, case insensitive

    const eventId = eventPart ? eventPart.replace('Event', '') : '';
    const cameraId = camPart ? camPart.replace('cam', '') : '';
    // console.log(`Eventid - > ${eventId}   cameraid  -> ${cameraId}`);
    return { eventId, cameraId };
}


// Function to distribute JPG files in batches
async function distributeJpgFiles(ws) {
    if (connectedUsers.size === 0) {
        return;
    }

    while (true) {
        const imagePaths = await fetchImagePathsBatch();

        // Break the loop if no more images are available
        if (imagePaths.length === 0) {
            // console.log("No more images to process.");
            break;
        }

        const batchPromises = imagePaths.map(async (imagePath) => {
            try {
                // Check if the image has already been processed
                if (processedImage.has(imagePath)) {
                    console.log(`Image ${imagePath} already processed`);
                    return;
                }

                // Extract event and camera IDs from the image path
                const { eventId, cameraId } = await extractEventAndCameraIds(imagePath);

                // Process the image data
                const processedData = await processImageData(eventId, cameraId, imagePath);

                if (processedData) {
                    // Distribute the processed data to users
                    await distributeDataToUsers(processedData, ws, imagePath);
                } else {
                    console.log(`No data to distribute for image ${imagePath}`);
                }
            } catch (error) {
                console.error(`Error processing image ${imagePath}:`, error);
            }
        });

        // Wait for the entire batch to complete before fetching the next batch
        await Promise.all(batchPromises);
    }
}
let lastUserIndex = -1; // Initialize to -1 so first increment points to first user

async function distributeDataToUsers(data, socket, imagepath) {
    const users = Array.from(connectedUsers.values());

    if (users.length === 0) {
        logger.info('No users to send data to.');
        stopDataSending();
        return;
    }

    let userFound = false;
    let attempts = 0;
    const totalUsers = users.length;

    // Round-robin logic
    while (attempts < totalUsers) {
        lastUserIndex = (lastUserIndex + 1) % totalUsers; // Move to the next user
        const userDetails = users[lastUserIndex];
        const userSocket = userDetails.socket;

        if (userSocket) {
            const userId = getUserIdFromSocket(userSocket); // Fetch user ID based on socket
            if (!userId) {
                console.log('User ID not found for the given socket.');
                attempts++;
                continue; // Try next user if userId is missing
            }

            if (userSocket instanceof WebSocket && userSocket.readyState === WebSocket.OPEN) {
                userSocket.send(data);
                userFound = true;
            } else if (userSocket instanceof net.Socket && !userSocket.destroyed) {
                userSocket.write(data);
                userFound = true;
            }

            if (userFound) {
                const eventId = extractEventIdFromData(data); // Extract event ID from data
                await updateEventUserMapping(eventId, userId, imagepath);
                break; // Exit loop after sending to a user
            }
        }

        attempts++; // Increment attempts
    }

    if (!userFound) {
        console.log('No available users to send data to.');
    }
}


async function updateEventUserMapping(eventId, userId,imagepath) {
    try{
    // Implement your database update logic here to store userId with eventId
    let sql = `INSERT INTO eventuser(event_id,user_id,event_path) values(?,?,?)`;
    await db.query(sql,[eventId,userId,imagepath]);
    }catch(er){
        console.log(er);
    }
}

// Example function to extract eventId from data
function extractEventIdFromData(data) {
    const match = data.match(/<EventAlert>(\d+)~/);
    return match ? match[1] : null;
}

const eventQueue = new Set();
const inProgressEvents = new Set();
async function processImageData(eventid, camera_id, imagepath) {
    // Early exit if either eventid or cameraid is empty
    if (!eventid || !camera_id) {
         console.log(`No data string -> ${eventid} -> ${camera_id}`);
        return;
    }
   
    if (processedEvents.has(eventid)) {
        // logger.info(`File already processed: ${eventid}`);
        return;
    }
    processedEvents.set(eventid, true);
    if (processedImage.has(imagepath)) {
        logger.info(`File already processed: ${imagepath}`);
        return;
    }
    if (inProgressEvents.has(eventid)) { 
         console.log(`Event ${eventid} already in progress`);
         return; 
    }
    
    
    inProgressEvents.add(eventid);
    try{
    // Fetch the event status
    const eventStatus = await HumanDetectedstatus(eventid, camera_id);
    if (!eventStatus || !eventStatus[0]) {
        logger.error(`No details found for event -> ${eventid}, camera -> ${camera_id}`);
         console.log(`No details found for event -> ${eventid}, camera -> ${camera_id}`);
        return;
    }

    const eventstatus = eventStatus[0].event_status;
    if (eventstatus != 0) {
         console.log(`Event already processed ->${eventid},  ${eventstatus}  `);
        return;
    }

    // Extract necessary information from eventStatus 
    const Event_Name = eventStatus[0].Event_Name;
    const Event_ID = eventStatus[0].Event_ID;
    const whatsappgroupname = eventStatus[0].whatsappgroupname;
    const enddate = eventStatus[0].enddate;
    const Alertmessage = eventStatus[0].Alertmessage;
    const cameraid = eventStatus[0].camera_id;
    const camera_name = eventStatus[0].camera_name;
    const IP_Domain = eventStatus[0].IP_Domain;
    const IP_port = eventStatus[0].IP_port;
    const IP_Uname = eventStatus[0].IP_Uname;
    const IP_Pwd = eventStatus[0].IP_Pwd;
    const RTSP_port = eventStatus[0].RTSP_port;
    const short_name = eventStatus[0].short_name;
    const SDK_ID = eventStatus[0].SDK_ID;
    const Dept_Location = eventStatus[0].Dept_Location;
    const Branch_name = eventStatus[0].Branch_name;
    const branchid = eventStatus[0].branch_id;
    const Dept_name = eventStatus[0].Dept_name;
    const device_name = eventStatus[0].device_name;
    const camera_status = eventStatus[0].Camera_Status;
    const Name1 = eventStatus[0].Name1;
    const Name2 = eventStatus[0].Name2;
    const Name3 = eventStatus[0].Name3;
    const Contact_mobile1 = eventStatus[0].Contact_mobile1;
    const Contact_mobile2 = eventStatus[0].Contact_mobile2;
    const Contact_mobile3 = eventStatus[0].Contact_mobile3;
    const Contact_Email1 = eventStatus[0].Contact_Email1;
    const Contact_Email2 = eventStatus[0].Contact_Email2;
    const Contact_Email3 = eventStatus[0].Contact_Email3;
    const Device_id = eventStatus[0].Device_id;
    const Imageurl = imagepath;
    const Notifytime = eventStatus[0].site_starttime;

    // Format the date strings
    const evDate = new Date(eventStatus[0].Row_updated_date);
    const formattedDateTime = `${evDate.getFullYear()}-${(evDate.getMonth() + 1).toString().padStart(2, '0')}-${evDate.getDate().toString().padStart(2, '0')} ${evDate.getHours().toString().padStart(2, '0')}:${evDate.getMinutes().toString().padStart(2, '0')}:${evDate.getSeconds().toString().padStart(2, '0')}`;

    const evDate1 = new Date(enddate);
    const enddateformat = `${evDate1.getFullYear()}-${(evDate1.getMonth() + 1).toString().padStart(2, '0')}-${evDate1.getDate().toString().padStart(2, '0')} ${evDate1.getHours().toString().padStart(2, '0')}:${evDate1.getMinutes().toString().padStart(2, '0')}:${evDate1.getSeconds().toString().padStart(2, '0')}`;

    // Update AI status in the database
    try{
    await updateaistatus(eventid, Imageurl);
    }catch(er){
        console.log(`Error updating AI status: ${er}`);
        return;
    }
    // Add to the processed events set
   
    processedImage.set(imagepath, true);
    // // Check if the camera is not ignored
    if (!(await checkCameraIgnored1(cameraid, 1)) && !(await checkCameraIgnored1(cameraid, 2))) {
    console.log(`<EventAlert>${eventid},${cameraid},${camera_id},${formattedDateTime},${device_name}</EventAlert>`);
    // await logEvent(eventid, cameraid, formattedDateTime,Imageurl);
    return `<EventAlert>${eventid}~${cameraid}~${Event_ID}~${Event_Name}~${whatsappgroupname}~${enddateformat}~${formattedDateTime}~${Alertmessage}~${camera_id}~${camera_name}~${Dept_Location}~${SDK_ID}~${cameraid}~${Branch_name}~${Dept_name}~${device_name}~${Imageurl}~${camera_status}~${IP_Domain}~${IP_port}~${IP_Uname}~${IP_Pwd}~${RTSP_port}~${Name1}~${Contact_mobile1}~${Contact_Email1}~${Name2}~${Contact_mobile2}~${Contact_Email2}~${Name3}~${Contact_mobile3}~${Contact_Email3}~${short_name}~1~${Device_id}~${branchid}~${Notifytime}</EventAlert>`;
     }else{
        console.log(`Event ignored`);
         return;
    }
}finally{
    inProgressEvents.delete(eventid);
}
}
// for (const queuedEvent of eventQueue) {
    //     // console.log(eventQueue);
    //     // Ensure that we only process unique events that are not already processed or in progress
    //     if (!processedEvents.has(queuedEvent.eventid) && !inProgressEvents.has(queuedEvent.eventid)) {
    //         // Process the next event in the queue
    //         eventQueue.delete(queuedEvent); // Remove from queue to prevent re-processing
    //         await processImageData(queuedEvent.eventid, queuedEvent.camera_id, queuedEvent.imagepath); // Process it
    //         //break; // Only process one event at a time
    //     }
    // }
// async function SetAIUpdate(eventaiid,status,eventid){
//     try{
//     let [sql] = await db.spcall(`CALL updatedaieventlog(?,?,?)`,[eventaiid,status,eventid]);
//     // console.log(`ai log updated successfully+ ${JSON.stringify(sql)}`);
//     }catch(er){
//         logger.error("ailog"+er);
//     }
// }
// Function to log the event
function getFormattedDateTime() {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0'); // Ensure two digits for month
    const day = String(date.getDate()).padStart(2, '0'); // Ensure two digits for day
    const hours = String(date.getHours()).padStart(2, '0'); // Ensure two digits for hours
    const minutes = String(date.getMinutes()).padStart(2, '0'); // Ensure two digits for minutes
    const seconds = String(date.getSeconds()).padStart(2, '0'); // Ensure two digits for seconds
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}


async function checkCameraIgnored1(cameraid,flag)
{
    try{
        const [sql] = await db.spcall(`CALL IsCameraIgnoredByCamID(?,?,@result); select @result`,[cameraid,flag]);
        // console.log(`sql -> ${JSON.stringify(sql)}}`);
        const objectvalue = sql[1][0];
        // console.log(`IsCameraIgnoredByCamID  ${objectvalue["@result"]}`);
        if(objectvalue["@result"] == '1'){
            return true;
        }
        else{
            return false;
        }
    }
    catch(er){
        logger.error("checkCameraIgnored1"   +er); 
    }
}


async function HumanDetectedstatus(eventId,cameraId) {
    try{
        const sql1 = await db.query(`SELECT em.Event_ID, em.Event_Name, bm.whatsappgroupname, em.Row_updated_date, em.enddate, em.Alertmessage,
        cm.camera_id, cm.camera_name, dm.IP_Domain, dm.IP_port, dm.IP_Uname, dm.IP_Pwd, dm.RTSP_port, dm.device_name, dm.short_name, dm.SDK_ID, dm.Device_id,bm.Branch_name Dept_name, bm.Branch_name Dept_Location, 
        dc.Name1, dc.Name2, dc.Name3, dc.Contact_mobile1, dc.Contact_mobile2, dc.Contact_mobile3, dc.Contact_Email1, dc.Contact_Email2, dc.Contact_Email3, bm.Branch_name, bm.site_starttime, 
        bm.branch_id, bm.contact_person, cm.Camera_Status, COALESCE(es.event_status, 0) AS event_status FROM eventmaster em
        LEFT JOIN eventstatus es ON es.Event_ID = em.Event_ID JOIN cameramaster cm ON cm.camera_id = em.analyticsource_id JOIN devicemaster dm ON dm.device_id = cm.device_id
        JOIN deptmaster dt ON dt.dept_id = dm.dept_id LEFT JOIN deptcontacts dc ON dc.dept_id = dt.dept_id
        JOIN branchmaster bm ON bm.branch_id = dt.branch_id WHERE em.Event_ID = ? LIMIT 1;`,[eventId]);

    return sql1;
 }catch(er){
    console.log(er);
    logger.error(`humandetectederror ${er}`);
 }
}


async function updateaistatus(eventId,eventpath) {
    try{
      let [sql] = await db.spcall(`CALL spupdateevent(?,?)`,[eventId,eventpath]);
    }catch(er){
        logger.error(`updateaistatus ${er}`); 
    }
}

async function clearProcessedEvents() {
    try {
        // Clear all events from the processedEvents set
        processedEvents.flushAll();
        logger.info('Successfully cleared all processed events');
    } catch (error) {
        logger.error('Error clearing processed events', error);
    }
}

async function clearProcessedImage() {
        try {
            processedImage.flushAll();
        } catch (error) {
            logger.error('Error deleting processed file:', error);
        }
}

// Start sending data periodically once users are logged in
function startDataSending(userId, ws) {
     dataInterval = setInterval(async () => {
        try {
            await distributeJpgFiles(ws); // Ensure the function runs asynchronously
        } catch (error) {
            console.error("Error during data distribution:", error);
        }
    }, 300); // Adjust the interval as needed
}

function stopDataSending() {
    clearInterval(dataInterval);
}


async function SendMessage(message,userid,username) {
    try{
    // const db1 = await db.query(`Insert into messagelog(messages,created_by) VALUES(?,?)`,[message,userid]);
    for (const [userId, user] of connectedUsers) {
        const { socket } = user; // Extract the socket object
        if (socket instanceof WebSocket && socket.readyState === WebSocket.OPEN) {
            socket.send(`<messagelog>${message}~${userid}~${username}</messagelog>`);
        } else if (socket instanceof net.Socket && !socket.destroyed) {
            socket.write(`<messagelog>${message}~${userid}~${username}</messagelog>`);   
        }
    }
    const db1 = await db.query(`Insert into messagelog(messages,created_by) VALUES(?,?)`,[message,userid]);
}catch(er){
    console.log(er);
}
}