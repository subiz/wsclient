# Subiz rtclient

This library implements subiz long polling protocol

## Method
### subscribe
### onEvents
### onInterrupted
### stop

## Example
```
var Realtime = require('@subiz/wsclient')
var realtime = new Realtime('https://realtime-0.subiz.net/', {
  account_id: 'ac1234',
  getAccessToken:()=> '333344',
  user_mask: 'mask123'
})

realtime.onEvent(ev => console.log(ev))
realtime.onInterrupted(() => console.log('some message may have been losted'))

// subscribe events
realtime.subscribe([ev1, ev2, ev3])

realtime.stop()
```
