var client = require('./client.js')
client.env.WebSocket = window.Websocket
module.exports = {WS: client.WS}
