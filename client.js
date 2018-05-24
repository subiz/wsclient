class WS {
	constructor(options) {
		this.onerror = this.onopen = this.onclose = this.ondead = () => {}
		var defsettings = {
			debug: false,
			reconnectInterval: 1000,
			maxReconnectInterval: 30000,
			reconnectDecay: 1.5,
			timeoutInterval: 2000,
			maxReconnectAttempts: null,
			pickUrl: done => done("")
		}
		Object.assign(this, defsettings, options || {})
		this.dead = false
		this.msgQ = []
		this.url = ""
		this.reconnectAttempts = 0
		this.sendloop()
		this.pickUrl(url => {
			this.url = url
			this.reconnect()
		})
	}

	halt() {
		this.dead = true
		if (this.ws) this.ws.close()
	}

	debugInfo(...msg) {
		if (this.debug || WS.debugAll) console.debug('WS', this.url, ...msg)
	}

	sendloop() {
		let handler = setInterval(() => {
			if (this.dead) {
				clearInterval(handler)
				return
			}
			if (!this.ws || this.ws.readyState != env.WebSocket.OPEN) return
			if (this.msgQ.length == 0) return
			var max = this.msgQ.reduce((a, b) => a > b ? a : b)
			if (!max) return
			this.debugInfo("send", max)
			this.ws.send(max)
			this.msgQ.length = 0
		}, 1000)
	}

	commit(offset) { this.msgQ.push(offset) }

	dispatch(eventType, event) {
		this.debugInfo({eventType, event})
		switch (eventType) {
		case "open":
			this.reconnectAttempts = 0
			break
		case "close":
			this.onclose(event)
			this.reconnect()
			break
		case "message":
			let mes = this.parseMessage(event.data)
			if (mes.error) {
				this.onerror(event, mes.error)
				this.onclose(event)
				this.connection_id = ""
				this.pickUrl(url => {
					this.url = url
					this.reconnect()
				})
				return
			}
			if (mes.offset == 0) { // first message
				var id = mes && mes.data && mes.data.id || ""
				if (!id) {
					this.onerror(event, "server error: invalid message format, missing connection id")
					this.reconnect()
					return
				}
				this.connection_id = id
				this.onopen(event, this.connection_id)
				return
			}
			this.onmessage(event, mes.data, mes.offset)
			break
		case "error":
			this.onerror(event, event)
			this.reconnect()
			break
		case "timeout":
			this.onerror(event, "cannot connect")
			this.reconnect()
			break
		case "outdated":
			this.ondead(event)
			this.halt()
			break
		}
	}

	parseMessage(data) {
		let message = {}
		try {
			message = JSON.parse(data)
			message.data = JSON.parse(message.data) || {}
		} catch(e) {}
		return message
	}

	reconnect() {
		if (this.reconnectAttempts > this.maxReconnectAttempts) {
			this.dispatch("outdated")
			return
		}
		let delay = this.calculateNextBackoff()
		setTimeout(() => this.connect(this.connection_id), delay)
		this.reconnectAttempts++
	}

	calculateNextBackoff() {
		let delaytime = this.reconnectInterval * Math.pow(this.reconnectDecay, this.reconnectAttempts)
		return delaytime > this.maxReconnectInterval ? this.maxReconnectInterval : delaytime
	}

	connect(id) {
		if (this.dead) return
		if (this.ws) this.ws.close()

		let url = id ? `${this.url}?connection_id=${id}` : this.url
		var ws = this.ws = new env.WebSocket(url)

		let timedOut = false
		var timeout = setTimeout(() => {
			timedOut = true
			ws.close()
			this.dispatch("timeout", id)
		}, this.timeoutInterval)

		let dispatch = (type, event) => {
			clearTimeout(timeout)
			if (!timedOut && ws === this.ws) this.dispatch(type, event)
		}

		ws.onopen = ev => dispatch('open', ev)
		ws.onclose = ev => dispatch('close', ev)
		ws.onerror = ev => dispatch('error', ev)
		ws.onmessage = ev => dispatch('message', ev)
	}
}

var env = {WebSocket: {}}
module.exports = {WS, env}
