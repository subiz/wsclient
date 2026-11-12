# Subiz wsclient

Subiz realtime subscriptions over HTTP long polling, with browser audio calling
through WebRTC.

| Entry point | Purpose |
| --- | --- |
| `@subiz/wsclient` | `Realtime`: event subscriptions, polling, and reconnects. |
| `@subiz/wsclient/webphone.js` | `WebPhone`: microphone capture, remote audio playback, and outbound number fallback. |
| `@subiz/wsclient/webrtc.js` | `WebRTCConn`: signaling and call lifecycle with application-owned UI and media capture. |

## Installation and runtime

```sh
npm install @subiz/wsclient
```

The package has no runtime dependencies and exports CommonJS modules. Use a
CommonJS-capable bundler for browser applications. `Realtime` uses
`XMLHttpRequest` when available and falls back to
global `fetch`; a custom transport can also be supplied.

`WebPhone` requires a browser with `window`, `document.body`, WebRTC, and
`navigator.mediaDevices.getUserMedia`. Initialize it after the document body
exists, in client-side code rather than during server-side rendering. Microphone
capture requires a secure context and user permission. Start calls from a user
action and account for the browser's audio autoplay policy.

## Realtime

```js
const Realtime = require('@subiz/wsclient')

const realtime = new Realtime('https://api.subiz.com.vn/rt/0/', {
	account_id: 'ac1234',
	getAccessToken: async () => 'YOUR_ACCESS_TOKEN',
})

realtime.onEvent((event) => console.log(event))
realtime.onInterrupted((reason) => console.log('Realtime interrupted:', reason))

async function startRealtime() {
	const result = await realtime.subscribe(['message_sent', 'user_info_updated'])
	if (result.error) {
		console.error('Subscription failed:', result.error)
		return
	}
	console.log(realtime.getStatus())
}

startRealtime().catch(console.error)

// When the application no longer needs events:
// realtime.stop()
```

Topic names and credentials must match the server's subscription permissions.
Construction creates the connection wrapper; polling starts after the first
successful nonempty subscription.

### Constructor

```js
new Realtime(apiUrls, credential, callAPI, accid, skipautoreconnect)
```

Only `apiUrls` and the credentials needed by your server are required.

| Parameter | Behavior |
| --- | --- |
| `apiUrls` | Endpoint string or nonempty array of endpoints, each ending in `/`. A host is selected randomly on each new connection. |
| `credential.account_id` | Account ID used unless the positional `accid` overrides it. |
| `credential.getAccessToken` | Function returning an access token or a Promise for one. Called for each subscription attempt, so it can refresh credentials. Defaults to an empty token. |
| `credential.user_ref` / `credential.user_mask` | Alternative subscription credentials. Precedence is `user_ref`, then `user_mask`, then the access token. `getAccessToken` is still called when either alternative is present. |
| `callAPI` | Optional transport; see [Custom HTTP transport](#custom-http-transport). |
| `accid` | Optional account ID override. |
| `skipautoreconnect` | Defaults to false. Set to true to disable automatic reconnects after connection failure. |

### Methods

| Method | Result and behavior |
| --- | --- |
| `subscribe(topics)` | Accepts a string or array of strings. Resolves to `{}` on success or `{error}` on failure. Deduplicates topics and batches up to 50 per request. |
| `onEvent(callback)` | Registers a callback receiving each event. Returns `undefined`; no listener removal API is exposed. |
| `onInterrupted(callback)` | Registers a callback for connection failure or explicit stop. Failure supplies `'poll'` or `'subs'`; explicit stop supplies no reason. Page-exit cleanup does not emit this callback. |
| `getStatus()` | Returns `'connecting'`, `'active'`, or `'dead'`. Initial state is `'connecting'`; `'active'` means subscriptions and polling are not currently marked as stuck. |
| `stop()` | Stops local polling, aborts pending requests, and disables automatic reconnects. Preserves the topic list for a later explicit reconnect. |
| `reconnect()` | Replaces the connection and resubscribes remembered topics. Resolves to the subscription result, `{}` or `{error}`. Works after `stop()`. |

There is no topic unsubscribe API. An explicit `reconnect()` replaces the
connection without emitting `onInterrupted` for the old connection.

Subscriptions are queued internally and sent one batch at a time. Duplicate
subscribers share the pending result, so every caller waits for
server confirmation and receives failures if the connection stops or is replaced.
Small batches wait up to 100 ms from their first queued topic; a queue exceeding 50 topics can
flush earlier. A pending request can delay later batches. Stopping or replacing
the connection also settles subscriptions still waiting in the queue.

### Retry and delivery behavior

The client reconnects two seconds after a connection dies and resubscribes its
remembered topics, unless stopped or automatic reconnects are disabled.

- Polls have a 105-second deadline, allowing for the server's 90-second hold.
  A timeout aborts the request and retries with the same sequential token.
- Network failures, HTTP 429, and HTTP 5xx are retryable. Poll retries use
  backoff capped at ten seconds, with a minimum 250 ms between poll starts.
- Subscription batches have a 60-second total deadline, including credential
  acquisition and retries. Retryable subscription failures wait three seconds
  before another attempt. Exhausting the deadline kills the connection.
- Other unsuccessful HTTP statuses, or a successful initial subscription/poll
  response missing its required token, kill the connection.
- `stop()` and `reconnect()` cancel connection requests and timers. Late
  responses are ignored even if the transport cannot abort requests.

Listener exceptions and rejected Promises are reported through `console.error`
without blocking other listeners or polling. Listener Promises are not awaited:
protocol progress does not acknowledge completion of your asynchronous event
processing. The client does not persist events or deduplicate application event
IDs; handle replay and durable processing in your application when needed.

### Browser page exit

Each browser instance listens for `pagehide`. When `persisted` is false, it
sends a best-effort `POST` to `cleanup` on the latest realtime host using the
latest sequential token, account ID, and last subscription credentials. It uses
`navigator.sendBeacon`, falling back to `fetch` with `keepalive: true` if needed.
It does not wait for an access-token refresh or use the custom `callAPI` hook.

Cleanup is sent only after a subscription token has been received. The exiting
instance stops polling and will not reconnect. A new page must
create a new instance. No cleanup is sent for network loss, a background tab,
or `pagehide` with `persisted: true`. Runtimes without a browser document do not
install this listener. Delivery on page exit is not guaranteed; server expiry
handles abandoned connections if cleanup cannot be delivered.

`stop()` removes the page listener and stops local work; it does not send a
server cleanup request. An explicit `reconnect()` reattaches the listener while
the page is still open.

## WebPhone

```js
const WebPhone = require('@subiz/wsclient/webphone.js')
const phone = new WebPhone('ac1234_ag5678_YOUR_AGENT_TOKEN')

phone.onEvent((event) => {
	const info = event.data.call_info
	console.log(event.type, info.call_id, phone.getCall(info.call_id))
	if (event.type === 'call_invited') {
		// Show an Answer button that calls answerIncoming(info.call_id).
	}
})

// Bind these functions to your application's call controls.
async function dial() {
	// This Promise settles when the call ENDS or setup fails.
	const result = await phone.makeCall('84900000000', ['84911111111', '84922222222'])
	if (result.error) console.error('Call failed:', result.error)
	else console.log('Call ended:', result.hangup_code)
}

async function answerIncoming(callid) {
	const result = await phone.answerWebCall(callid)
	if (result && result.error) console.error('Answer failed:', result.error)
}

function sendDigit(key) {
	return phone.sendDtmf(key, phone.getCurrentCallId())
}

function transfer(number) {
	return phone.transferCall(number, phone.getCurrentCallId())
}

function hangup() {
	phone.hangupCall()
}
```

Do not wait for `makeCall()` to resolve before enabling hangup, DTMF, or transfer
controls. Use events and `getCurrentCallId()` while the call is in progress.
Each outbound fallback attempt gets a new call ID. Event `call_info` can be
partial; `getCall(callid)` provides the current locally known state.

### Constructor

```js
new WebPhone(access_token, realtime)
```

`access_token` must be an agent token shaped like `ac..._ag..._...`. The wrapper
uses this fixed token for signaling and integration lookup; it does not expose
a token refresh setter. The optional `realtime` must serve the same account and
agent. Otherwise, the wrapper creates its own `Realtime` instance.

The wrapper appends a hidden autoplay `<audio>` element to `document.body` and
assigns remote audio to it. It fetches activated call integrations immediately
and schedules another lookup two minutes after each response. If from-numbers
are omitted before that initial lookup finishes, dialing can return
`{error: 'out_of_number'}`. Pass explicit from-numbers when needed.

### Methods

| Method | Result and behavior |
| --- | --- |
| `makeCall(number, fromnumbers, streamPm)` | Resolves to an ended call object or `{error}`. Optional `fromnumbers` accepts a string, number, or array; omitted/empty values use the discovered integrations. Optional `streamPm` supplies a microphone stream or Promise for one. |
| `answerWebCall(callid)` | Requests microphone access and answers. Resolves to the parsed response body or `{error}` after setup, rather than waiting for call end. |
| `hangupCall(callid)` | Ends the call locally and sends a best-effort server hangup. Defaults to the current call ID. Returns `undefined`. |
| `sendDtmf(key, callid)` | Sends a digit; resolves to `{body}` or `{error}`. Requires an explicit call ID. |
| `transferCall(number, callid)` | Requests a transfer; resolves to `{body}` or `{error}`. Requires an explicit call ID. |
| `onEvent(callback)` | Registers a callback for call events such as `call_invited`, `call_ringing`, `call_joined`, and `call_ended`. No unsubscribe handle is returned. |
| `getCall(callid)` | Returns known call state, or `undefined`. Omitting the ID returns the call map. Ended calls are periodically removed. |
| `getCurrentCall()` | Finds the current non-ended call, or returns `undefined`. May update the current call ID. |
| `getCurrentCallId()` | Returns the last selected call ID, or `''`. An ID alone does not mean the call is still active. |
| `checkMic()` | Starts a microphone request and returns `{timeout, result}` Promises; see below. |
| `isMicAllowed()` | Requests microphone access and resolves to a boolean. This can show a permission prompt and acquire a stream. |
| `getMicroStream()` | Returns the last acquired microphone stream, if any. Its tracks may already have stopped. |

Calls without a usable connection can make DTMF/transfer return an empty result
without sending a request. Treat these as commands for an established call.

### Number fallback and microphone ownership

From-numbers are attempted in order. An unanswered call retries the next number
only for `terminated`, `failure`, or `congestion` hangup codes. Cancellation,
an answered call, or a result with `error` stops the sequence. Exhaustion returns
the last failed call; if there was no eligible number, it returns an ended result
with `error: 'out_of_number'` without acquiring a microphone.

Each attempt uses a clone of the source microphone stream. The source stays
live across retries and all its tracks are stopped when the dialing sequence
finishes, including when you supplied `streamPm`. Supply a clone if another part
of the application needs to retain its own stream.

`checkMic().result` resolves to a `MediaStream`, or `undefined` if permission
fails. `checkMic().timeout` resolves to the same result if ready within 500 ms,
otherwise to `'Not_authorized'`. That string means the request is still pending,
not necessarily denied; the request continues. Standalone permission checks do
not stop the acquired tracks. Release an unused result yourself:

```js
async function checkAndReleaseMicrophone() {
	const {result} = phone.checkMic()
	const stream = await result
	if (!stream) return false
	stream.getTracks().forEach((track) => track.stop())
	return true
}
```

### Setup, errors, and lifecycle

Each call setup attempt has one shared **60-second deadline** covering microphone
permission, realtime subscription, SDP/ICE, and the call/answer response. It is
not reset between stages. A timeout returns `{error: 'setup_timeout'}` and
releases the peer and media. Successful setup clears the deadline; it does not
limit call duration.

Hangup settles a pending setup even while microphone permission is unresolved.
A stream granted after cancellation or timeout is stopped. Listener exceptions
and rejected Promises are logged without interrupting signaling or cleanup.

Common setup errors include `no_stream`, `setup_timeout`, and subscription or
signaling errors. Error values may include a server response, rather than a
fixed enum. Check the resolved result's `error` property and also handle rejected
Promises from application-supplied media providers or browser API failures.

Transport failures can produce local `call_ended` events. A disconnected peer
has a 30-second recovery window; failed or closed transports end immediately.
The client also checks for stale RTP counters and unanswered invitations, with
90-second and 120-second thresholds respectively when their checks apply.

`WebPhone` currently exposes no `shutdown()` or `destroy()` method. Hanging up
releases call media but does not stop its integration refresh timer, remove its
audio element, or dispose its realtime connection. Reuse one wrapper for the
page lifetime. Use `WebRTCConn` directly when you need explicit disposal or
control over audio rendering.

## WebRTCConn (advanced)

The lower-level client manages signaling and peers. Your application supplies
microphone streams, renders remote tracks, and owns the realtime connection.

```js
const Realtime = require('@subiz/wsclient')
const WebRTCConn = require('@subiz/wsclient/webrtc.js')

const accessToken = 'ac1234_ag5678_YOUR_AGENT_TOKEN'
const realtime = new Realtime('https://api.subiz.com.vn/rt/0/', {
	account_id: 'ac1234',
	getAccessToken: () => accessToken,
})
const audio = document.createElement('audio')
audio.autoplay = true
document.body.appendChild(audio)

const rtc = new WebRTCConn({
	accid: 'ac1234',
	agid: 'ag5678',
	access_token: accessToken,
	realtime,
	env: window,
	setupTimeoutMs: 60000,
	onEvent: (event) => console.log(event),
	onTrack: (event) => {
		if (event.track.kind === 'audio') audio.srcObject = event.streams[0]
	},
})

// Bind to an Answer button for a call received through onEvent.
async function answer(callid) {
	const streamPromise = navigator.mediaDevices.getUserMedia({audio: true, video: false})
	const result = await rtc.answerCall(callid, streamPromise)
	if (result.error) console.error(result.error)
	return result
}

function dispose() {
	for (const [callid, call] of Object.entries(rtc.matchCall())) {
		if (call.status !== 'ended') rtc.hangupCall(callid)
	}
	rtc.shutdown()
	realtime.stop() // Only stop a realtime instance owned by this application scope.
	audio.srcObject = null
	audio.remove()
}
```

### Options

Required options are `accid`, `agid`, `access_token`, `realtime`, and `env`.
For browsers, pass `window` as `env`; custom environments must provide WebRTC
constructors, `Promise`, `JSON`, `Date`, and timeout/interval functions. The
default transport also uses global `XMLHttpRequest` or `fetch`; `env` alone is
not a complete native-runtime adapter.

| Optional option | Default and behavior |
| --- | --- |
| `apiUrl` | `https://callcenter.subiz.com.vn/wc/`; must end in `/`. |
| `setupTimeoutMs` | `60000`; a positive number overrides the shared setup budget. |
| `callAPI` | Custom signaling transport using the contract below. |
| `onEvent(event)` | Receives call lifecycle events. |
| `onTrack(event)` | Receives remote track events for application-managed playback. |
| `collect(name, callid, durationMs)` | Optional timing callback. |
| `apiHostSuffixes` | `['.subiz.com.vn']`; allowed hosts for server-returned HTTPS `api_url` values. A leading dot matches subdomains; other entries match an exact host. |

An accepted server `api_url` pins subsequent requests to the call's host. A
network failure on a pinned host retries once through `apiUrl`; HTTP 4xx/5xx do
not trigger that fallback. Callback failures are logged and isolated.

### Methods

| Method | Contract |
| --- | --- |
| `makeCall(number, fromnumber, streamPm, callid, campaignid, outboundcallentryid, channel)` | Requires a Promise for a live audio stream. Optional call ID is generated if absent; the final three arguments add call metadata. Resolves on call end or setup failure. No number fallback is performed here. |
| `answerCall(callid, stream)` | Accepts a stream or Promise. Resolves after answer setup to `{body}` or `{error}`. If the call ends during setup, resolves to `{error: 'call_ended'}`. |
| `listenCall(callid, callback)` | Receive-only setup. Calls `callback(error, connectionId)` once ICE connects or setup fails. |
| `joinCall(callid, stream, callback)` | Bidirectional setup with an already acquired stream. Same callback contract as `listenCall`. |
| `hangupCall(callid)` | Ends locally and signals server hangup. Returns `undefined`. |
| `sendDtmf(key, callid)` / `transferCall(number, callid)` | Same signaling commands exposed by `WebPhone`. |
| `setCallMuted(callid, muted)` | Enables/disables local audio tracks. Returns `{body: {muted}}` or `{error}`. |
| `isCallMuted(callid)` | Returns the locally stored mute state. |
| `matchCall(callid)` | Returns known call state. Omit the ID, or pass `'*'` or `'-'`, for the call map. |
| `expireCall(callInfo)` | Marks a call ended locally and emits `call_ended`; requires `callInfo.call_id`. Does not signal server hangup. |
| `debugState()` | Returns a diagnostic snapshot of calls, sessions, and transport state. |
| `shutdown()` | Cancels pending setup and call waits, closes peers, stops owned media and timers, and ignores late results. Terminal for this instance. |

Success callbacks for `listenCall`/`joinCall` receive `undefined` as the first
argument. Awaiting those methods does not give a `{body}`/`{error}` result; use
the callback. Streams passed into call setup become owned by the client and
are stopped on cleanup. New setup for the same call replaces older setup;
superseded operations can return `replaced`.

`shutdown()` does not stop the supplied realtime instance or send server hangups.
Call `hangupCall()` first when you need to signal termination. The realtime
listener remains registered but ignores events after shutdown; dispose an owned
realtime instance alongside the client.

## Custom HTTP transport

Both `Realtime` and `WebRTCConn` accept:

```js
function callAPI(method, url, body, callback) {
	// Send the request, then invoke callback(responseText, httpStatus).
	// Use 0 or -1 for a network failure.
	// Optionally return {abort() { ... }} or a cancellation function.
}
```

`body` is a serialized string or `undefined`; the callback takes response text
first and numeric status second. The built-in transport uses `text/plain` for
nonempty request bodies. Return a cancellation handle to release network work
on stop, replacement, or deadline expiry. Without one, lifecycle guards still
ignore late setup/poll responses. The built-in fetch transport uses
`AbortController` when available.

Realtime request deadlines and WebRTC setup deadlines are managed by the client.
The WebRTC setup budget does not impose a deadline on later DTMF, transfer, or
hangup requests. `WebPhone` does not expose a custom signaling transport option.

## Development

```sh
npm install
npm test
```

The test command runs realtime lifecycle, HTTP transport, and WebRTC lifecycle
regressions with Node's test runner, followed by the existing Tape realtime
suite. WebRTC tests use simulated peers, media streams, transports, and clocks;
real-browser microphone, playback, and network interoperability require separate
integration testing.
