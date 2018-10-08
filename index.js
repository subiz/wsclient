var client = require('./src/client.js');
client.env.WebSocket = window.WebSocket;
module.exports = { WS: client.WS };
