const http = require('http')
const WebSocket = require('ws')
const url = require('url')
const querystring = require('querystring')

const server = http.createServer()
const wss1 = new WebSocket.Server({ noServer: true })
const wss2 = new WebSocket.Server({ noServer: true })
const wss3 = new WebSocket.Server({ noServer: true })

let counter = {}

function getID(path) {
    const pathname = url.parse(path).pathname
    return pathname.split('/')
}

wss1.on('connection', ws => {
    ws.send(`{"offset": 0, "data": ${JSON.stringify(JSON.stringify({id: "aaa"}))}}`)
    ws.send(`{"offset": 1, "data":"1"}`)
    ws.send(`{"offset": 2, "data":"2"}`)
})

wss2.on('connection', (ws, request) => {
    let [x, no, id] = getID(request.url)

    if (!counter[id]) counter[id] = 0
    counter[id]++

    console.log(`[${id}] new connection`, counter[id])

    let qs = request.url.split('?')[1] || ''
    const params = querystring.parse(qs)

    console.log('params', params)

    if (counter[id] == 1) {
        ws.send(`{"offset": 0, "data": ${JSON.stringify(JSON.stringify({id: counter[id]}))}}`)
        ws.send(`{"offset": 1, "data":"1"}`)
        ws.terminate()
        return
    }

    if (counter[id] < 4) {
        if (!params.connection_id) {
            throw new Error('connection_id not found')
        }

        ws.terminate()
        return
    }

    if (counter[id] === 4) {
        ws.send(`{"error": "dead"}`)
        return
    }

    if (counter[id] === 5) {
        if (Object.keys(params).length > 0) {
            throw new Error('query string is not empty')
        }

        ws.send(`{"offset": 0, "data": ${JSON.stringify(JSON.stringify({id: counter[id]}))}}`)
        ws.send(`{"offset": 1, "data":"2"}`)
    }
})

wss3.on('connection', (ws, request) => {
    let [x, no, id] = getID(request.url)

    if (!counter[id]) counter[id] = 0
    counter[id]++

    console.log(`[${id}] new connection`, counter[id])

    if (counter[id] == 1) {
        ws.send(`{"offset": 0, "data": ${JSON.stringify(JSON.stringify({id: counter[id]}))}}`)
        ws.send(`{"offset": 1, "data":"1"}`)
        ws.terminate()
        return
    }

    if (counter[id] < 4) {
        ws.terminate()
        return
    }

    if (counter[id] === 4) {
        ws.send(`{"offset": 0, "data": ${JSON.stringify(JSON.stringify({id: counter[id]}))}}`)
        ws.send(`{"offset": 1, "data":"2"}`)
    }
})

server.on('upgrade', (request, socket, head) => {
    let [x, no, id] = getID(request.url)

    switch (no) {
        case '1':
            wss1.handleUpgrade(request, socket, head, ws => {
                wss1.emit('connection', ws, request)
            })
            break
        case '2':
            wss2.handleUpgrade(request, socket, head, ws => {
                wss2.emit('connection', ws, request)
            })
            break
        case '3':
            wss3.handleUpgrade(request, socket, head, ws => {
                wss3.emit('connection', ws, request)
            })
            break
        default:
            socket.destroy()
    }
})

server.listen(8088)
