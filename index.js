var client = require('./client.js')
client.env.WebSocket = window.WebSocket
module.exports = {WS: client.WS}
