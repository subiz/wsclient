# Subiz ws client

This library implement subiz ws protocol

# Example
```
	let WS = require('@subiz/wsclient').WS
	var ws = new WS({
		pickUrl: done => {
			let urls = ["ws-a.subiz.com", "ws-b.subiz.com", "ws-c.subiz.com"]
			let url = Math.round(Math.random() * urls.length)
			done(url)
		},
		maxReconnectAttempts: 20,
	})
	ws.onopen = (ev, id) => { console.log("new connection id", id)}
	ws.onclose = () => { console.log("disconnected") }
	ws.onerror = (ev, err) => { console.error("err", err) }
	ws.onmessage = (ev, mes) => { console.log("new message", msg}
	ws.ondead = () => { ws = nil } // unable to reconnect, should refresh browser
```
