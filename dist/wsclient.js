!function(e,t){"object"==typeof exports&&"object"==typeof module?module.exports=t():"function"==typeof define&&define.amd?define([],t):"object"==typeof exports?exports.beta=t():e.beta=t()}("undefined"!=typeof self?self:this,function(){return r={},o.m=n=[function(e,t){e.exports=function t(n){var e=n();if(!e.then){var r=e;e={then:function(e){e(r)}}}return e.then(function(e){return e?t(n):Promise.resolve()})}},function(e,t,n){e.exports=n(2)},function(e,t,n){e.exports=n(3)},function(e,t,n){var r=n(4);function l(u,n,f,o,s){s=s||i,n=n||{};var c=!1,a="";this.kill=function(){c=!0};var l=function(r){c||s("get",u+"poll?token="+a,void 0,function(e,t){if(!c){if(d(t))return setTimeout(l,v(r),r+1);if(200!==t)return c=!0,f("poll");(e=p(e)||{}).host&&(u=b(e.host));var n=e.sequential_token;return n?(a=n,o(e.events||[]),l(0)):setTimeout(l,v(r),r+1)}})},t=r.batch(50,100,function(o){if(c)return["dead"];if(o.length<=0)return[];var i=[];return r.loop(function(){return new Promise(function(r){var t="?token="+a;n.getAccessToken().then(function(e){n.user_mask?t+="&user-mask="+encodeURIComponent(n.user_mask):e&&(t+="&access-token="+e),s("post",u+"subs"+t,JSON.stringify({events:o}),function(e,t){if(c)return i=m("dead",o.length),r(!1);if(d(t))return setTimeout(r,3e3,!0);if(200!==t)return c=!0,f("subscribe",e,t),i=m("dead",o.length),r(!1);if(a)return r(!1);var n=(e=p(e)||{}).initial_token;return n?(e.host&&(u=b(e.host)),a=n,l(0),r(!1)):setTimeout(r,3e3,!0)})})})}).then(function(){return i})});this.subscribe=function(e){return t.push(e)}}function i(e,t,n,r){var o=new XMLHttpRequest;o.onreadystatechange=function(e){4===o.readyState&&(r&&r(o.responseText,o.status),r=void 0)},o.onerror=function(){r&&r(o.responseText,-1),r=void 0},o.open(e,t),n&&o.setRequestHeader("content-type","text/plain"),o.send(n)}function p(e){try{return JSON.parse(e)}catch(e){}}function h(){var o={};this.emit=function(e){for(var t=[],n=1;n<arguments.length;n++)t.push(arguments[n]);var r=o[e];if(r)for(n=0;n<r.length;n++)r[n].apply(void 0,t)},this.on=function(e,t){o[e]||(o[e]=[]),o[e].push(t)}}function v(e){if(!e||-1===e)return 0;var t=1e3*Math.pow(1.5,e);return Math.min(1e4,t)}function d(e){return 500<=e&&e<600||0===e||-1===e||429===e}function m(e,t){for(var n=[],r=0;r<t;r++)n.push(e);return n}function b(e){return(e=e||"").startsWith("//")?"https:"+e:e}e.exports=function(r,o,i){("string"==typeof r||r instanceof String)&&(r=[r]),(o=o||{}).getAccessToken||(o.getAccessToken=function(){return Promise.resolve("")});var u,f=new h,s={},c=!1;this.stop=function(){c||(c=!0,u.kill())},this.onEvent=function(e){return f.on("event",e)},this.onInterrupted=function(e){return f.on("interrupted",e)},this.subscribe=function(n){if(c)return Promise.resolve();if(!Array.isArray(n))return Promise.reject("param should be an array");for(var e=[],t=0;t<n.length;t++)s[n[t]]||e.push(u.subscribe(n[t]));return 0===e.length?Promise.resolve():Promise.all(e).then(function(e){for(var t=0;t<e.length;t++)if(e[t])return e[t];for(t=0;t<n.length;t++)s[n[t]]=!0})};var a=function(){if(!c){var e=r[Math.floor(Math.random()*r.length)];u=new l(e,o,function(e,t,n){c||(f.emit("interrupted",e,t,n),setTimeout(a,2e3))},function(e){if(!c)for(var t=0;t<e.length;t++)f.emit("event",e[t])},i);for(var t=Object.keys(s),n=0;n<t.length;n++)u.subscribe(t[n])}};a()}},function(e,t,n){var r=n(5),o=n(0),i=n(6),u=n(8);e.exports={sleep:r,loop:o,map:i,batch:u}},function(e,t){e.exports=function(t){return new Promise(function(e){setTimeout(e,t)})}},function(e,t,n){var l=n(7);e.exports=function(e,t,s){var c={};l.map(e,function(e,t){c[t]=e}),t<=0&&(t=1),Object.keys(c).length<t&&(t=Object.keys(c).length);var a={};return new Promise(function(u){for(var f=function(){var e=Object.keys(c);if(0!==e.length){var t=e.pop(),n=c[t];delete c[t];var r=0===e.length,o=s(n,t);if(!o.then){var i=o;o={then:function(e){return e(i)}}}o.then(function(e){if(a[t]=e,r)return u(l.map(a));f()})}},e=0;e<t;e++)setTimeout(f,1)})}},function(e,t){e.exports={map:function(e,t){if(!e)return[];t=t||function(e){return e};var n=[];if(Array.isArray(e)){for(var r=0;r<e.length;r++)n.push(t(e[r],r));return n}if("object"!=typeof e)return n;var o=Object.keys(e);for(r=0;r<o.length;r++){var i=o[r];n.push(t(e[i],i))}return n}}},function(e,t,n){var s=n(0);e.exports=function(t,n,i){function r(e){var t=e.map(function(e){return e.payload}),n=i(t);if(!n.then){var r=n;n={then:function(e){return e(r)}}}var o=e.map(function(e){return e.rs});return new Promise(function(e){n.then(function(n){o.map(function(e,t){e(n&&n[t])}),e()})})}var o=[],u="idle",f=function(){"executing"!==u&&(u="executing",s(function(){if(o.length<=t)return Promise.resolve(!1);var e=o.splice(0,t);return r(e).then(function(){return!0})}).then(function(){if(0!==o.length){var e=n-(Date.now()-o[0].created);if(1<=e){if(u="idle",o[0].settedTimeout)return;return o[0].settedTimeout=!0,void setTimeout(f,e)}var t=o;o=[],r(t).then(function(){u="idle",f()})}else u="idle"}))};return this.push=function(t,n){return new Promise(function(e){o.push({payload:t,priority:n,created:Date.now(),rs:e}),f()})},this}}],o.c=r,o.d=function(e,t,n){o.o(e,t)||Object.defineProperty(e,t,{enumerable:!0,get:n})},o.r=function(e){"undefined"!=typeof Symbol&&Symbol.toStringTag&&Object.defineProperty(e,Symbol.toStringTag,{value:"Module"}),Object.defineProperty(e,"__esModule",{value:!0})},o.t=function(t,e){if(1&e&&(t=o(t)),8&e)return t;if(4&e&&"object"==typeof t&&t&&t.__esModule)return t;var n=Object.create(null);if(o.r(n),Object.defineProperty(n,"default",{enumerable:!0,value:t}),2&e&&"string"!=typeof t)for(var r in t)o.d(n,r,function(e){return t[e]}.bind(null,r));return n},o.n=function(e){var t=e&&e.__esModule?function(){return e.default}:function(){return e};return o.d(t,"a",t),t},o.o=function(e,t){return Object.prototype.hasOwnProperty.call(e,t)},o.p="",o(o.s=1);function o(e){if(r[e])return r[e].exports;var t=r[e]={i:e,l:!1,exports:{}};return n[e].call(t.exports,t,t.exports,o),t.l=!0,t.exports}var n,r});