# Subiz ws client

This library implements subiz ws protocol

# Example
```
let WS = require('@subiz/wsclient').WS
var ws = new WS({
	pickUrl: done => {
		let urls = ["ws-a.subiz.com", "ws-b.subiz.com", "ws-c.subiz.com"]
		let url = urls[Math.round(Math.random() * urls.length)]
		done(url)
	},
})
ws.onopen = (ev, id) => console.log("new connection id", id)
ws.onclose = () => console.log("disconnected, should refresh browser")
ws.onerror = (ev, err) => console.error("err", err)
ws.onmessage = (ev, mes, offset) => {
	console.log("new message", msg)
	ws.commit(offset)
}
```
If you have init connection id, pass it through initConnection
```
let WS = require('@subiz/wsclient').WS
var ws = new WS({
	pickUrl: done => {
		let urls = ['ws-a.subiz.com', 'ws-b.subiz.com', 'ws-c.subiz.com']
		let url = urls[Math.round(Math.random() * urls.length)]
		done(url)
	},
	initConnection: '0wsadflkj43453444332',
})
```

# Config

### debug: false
turn on debug mode, print out debug message

### reconnectInterval: 1000
lower bound reconnect interval

### maxReconnectInterval: 30000
upper bound reconnect interval

### reconnectDecay: 1.5

### timeoutInterval: 2000
time waited to connect

### maxReconnectAttempts: null,

### pickUrl: done => done("")
this function get call every time we need connection to new ws

### initConnection
pass init connection id to ws client
