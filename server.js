const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files from the "public" directory
app.use(express.static(__dirname));

// Load chat history from file
const DATA_FILE = path.join(__dirname, 'chat-logs.json');
let messageHistory = [];

// Load users
const USERS_FILE = path.join(__dirname, 'users.json');
let users = {};
if (fs.existsSync(USERS_FILE)) {
  try {
    users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    console.log(`Loaded ${Object.keys(users).length} users from users.json`);
  } catch (err) {
    console.error('Error parsing users.json:', err);
  }
} else {
  console.log('Warning: users.json not found at', USERS_FILE);
}

if (fs.existsSync(DATA_FILE)) {
  try {
    messageHistory = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (err) {
    console.error('Error loading chat logs:', err);
  }
}

const voiceChannels = {}; // { channelName: { socketId: 'username', ... } }

// Handle socket connections
io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  // Send existing voice users to the new user
  socket.emit('all-voice-users', voiceChannels);

  // Handle Login
  socket.on('login', (userId, callback) => {
    if (users[userId]) {
      callback({ success: true, userData: users[userId] });
    } else {
      callback({ success: false, message: "Invalid User ID" });
    }
  });

  // --- WebRTC Signaling ---

  socket.on('join-voice', (channel, username) => {
    if (!voiceChannels[channel]) {
      voiceChannels[channel] = {};
    }

    // Send existing users to the new user
    socket.emit('existing-voice-users', voiceChannels[channel]);

    // Add new user to the channel
    voiceChannels[channel][socket.id] = username;

    // Announce new user to all other users in that channel
    // We use socket.broadcast.to() to avoid sending to the new user themselves
    socket.broadcast.to(channel).emit('new-voice-user', { socketId: socket.id, username });

    // Join the socket.io room
    socket.join(channel);

    // Broadcast updated user list to everyone (for the sidebar)
    io.emit('voice-users-update', { channel, users: Object.values(voiceChannels[channel]) });
  });

  socket.on('relay-offer', (data) => {
    socket.to(data.to).emit('offer-received', { from: socket.id, offer: data.offer });
  });

  socket.on('relay-answer', (data) => {
    socket.to(data.to).emit('answer-received', { from: socket.id, answer: data.answer });
  });

  socket.on('relay-ice', (data) => {
    socket.to(data.to).emit('ice-candidate-received', { from: socket.id, candidate: data.candidate });
  });

  socket.on('leave-voice', () => {
    // Find which channel the user was in and remove them
    for (const channel in voiceChannels) {
      if (voiceChannels[channel][socket.id]) {
        delete voiceChannels[channel][socket.id];
        socket.broadcast.to(channel).emit('user-left-voice', socket.id);
        socket.leave(channel);
        
        // Broadcast updated user list to everyone
        io.emit('voice-users-update', { channel, users: Object.values(voiceChannels[channel]) });
        break;
      }
    }
  });

  // Listen for joining a specific channel
  socket.on('join channel', (channel) => {
    socket.join(channel);

    // Send history for this channel
    const channelMessages = messageHistory.filter(msg => msg.channel === channel);
    channelMessages.forEach(msg => {
      socket.emit('chat message', msg);
    });
  });

  // Listen for 'chat message' events from the client
  socket.on('chat message', (msg) => {
    // Save message to history
    messageHistory.push(msg);

    // Persist to file
    fs.writeFile(DATA_FILE, JSON.stringify(messageHistory), (err) => {
      if (err) console.error('Error saving chat logs:', err);
    });

    // Broadcast the message to everyone in the specific channel
    io.to(msg.channel).emit('chat message', msg);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    // Also handle leaving voice channel on disconnect
    for (const channel in voiceChannels) {
      if (voiceChannels[channel][socket.id]) {
        delete voiceChannels[channel][socket.id];
        socket.broadcast.to(channel).emit('user-left-voice', socket.id);
        
        // Broadcast updated user list to everyone
        io.emit('voice-users-update', { channel, users: Object.values(voiceChannels[channel]) });
        break;
      }
    }
  });
});

// Render sets the PORT environment variable automatically
const PORT = process.env.PORT || 24;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

