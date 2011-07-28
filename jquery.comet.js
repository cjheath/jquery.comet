/*
 * JQuery long-polling message queueing plugin.
 *
 * This implements a bi-direction asynchronous JSON message queueing service over
 * COMET. Because it only uses XHR, it can be used on any server that supports
 * long-polling; Flash sockets and Web Socket support are not needed.
 *
 * Two connections are used; one for sending messages and one for long-polling.
 * Messages are never sent on the long-polling connection, even if available.
 * Any response messages available when sent messages have been delivered
 * will be returned on that channel, or at other times via the polling channel.
 *
 * A message is either a command or a data message, or an array of them (mixed).
 * Every message sent contains a client ID returned from an initial handshake.
 *
 * Message Sequencing (NOT COMET):
 * Each message sent and received contains a sequential sequence number called id.
 * The response will be either a single message or an array of messages.
 * Each response message from the server (returned either via a poll or in
 * response to synchronous messages) will likewise contain an "id" property.
 *
 * In the event that no application messages are returned from a synchronous call,
 * the following single message will be returned (to carry the confirm):
 *	{seq: <server sequence number>, confirm: <client sequence number>}
 *
 * On XHR failure, the request will initially be retried immediately, then after
 * errorDelay, increasing exponentially (by errorBackoff) up to errorMaxDelay.
 *
 * Copyright: Clifford Heath, Data Constellation, http://dataconstellation.com, 2011
 * License: MIT
 */
(function($) {
  $.comet = new function() {
    var	// Connection details:
	url,				// URL for the server
	isCrossDomain,			// Set to true for cross-domain, to force JSONP
	connected = false,		// Successful handshake yet?
	clientId,			// The client ID assigned by the server

	// Connection failure handling:
	errorCount = 0,			// Count of consecutive failed requests
	errorTimeout = null,		// Current timeout object (to cancel on disconnect)
	errorLastDelay = null,		// Current timeout duration
	errorDelay = 5*1000,		// Initial timeout in milliseconds for retry on error
	errorBackoff = 1.5,		// Multiplier to increase timeout
	errorMaxDelay = 60*1000,	// ... up to the maximum error delay

	// Inbound:
	polling = null,			// The XHR object for our long poll
	receivedSeq = null,		// Sequence number for last message we received
	receiptSent = null,		// Sequence number we last confirmed to the server

	// Outbound:
	sentSeq = 0,			// Sequence number for messages we send
	confirmedSeq = null,		// Sequence number of last confirmed sent message
	sending = null,			// The XHR object for a synchronous message
	messagesQueued = [],		// Messages that have been published but not yet sent
	batchNesting = 0,		// Nesting count of message batches

	// Message channel subscriptions:
	subscriptions = {};		// Keyed by channel name, each entry an array of callbacks

    // Private methods, forward declared:
    var ajax, backoff, reconnect, poll, handshake, send, deliver, confirmed, command;
    var advice;

    // Public methods
    this.connect = function(_url, options) {
      if (connected)
	this.disconnect();

      url = _url;
      options = options || {};
      // REVISIT: Handle more options, including timeouts and an auth-challenge callback.
      isCrossDomain =
	url.substring(0,4) == 'http' &&
	url.substr(7,location.href.length).replace(/\/.*/, '') != location.host;

      // Connection failure handling:
      errorCount = 0;			// Count of consecutive failed requests
      errorTimeout = null;		// Current timeout object (to cancel on disconnect)
      errorLastDelay = null;		// Current timeout duration

      // Inbound:
      polling = null;			// The XHR object for our long poll
      receivedSeq = null;		// Sequence number for last message we received
      receiptSent = null;		// Sequence number we last confirmed to the server

      // Outbound:
      sentSeq = 0;			// Sequence number for messages we send
      confirmedSeq = null;		// Sequence number of last confirmed sent message
      sending = null;			// The XHR object for a synchronous message
      messagesQueued = [];		// Messages that have been published but not yet sent
      batchNesting = 0;			// Nesting count of message batches

      // Message channel subscriptions:
      subscriptions = {};		// Keyed by channel name, each entry an array of callbacks

      errorDelay = options['errorDelay'] || 5*1000;   // Initial retry after 5 seconds
      errorBackoff = options['errorBackoff'] || 1.5;  // Delay multiplier on each error
      errorMaxDelay = options['errorMaxDelay'] || 60*1000;  // Maximum retry delay

      // Kick off the party
      handshake();
    };

    this.disconnect = function() {
      // Sending a disconnect will terminate the poll
      for (var channel in subscriptions)
	command({channel: '/meta/subscribe', subscription: channel});
      this.publish('/meta/disconnect', {id: (++sentSeq).toString(), clientId: clientId, channel: '/meta/disconnect'});
      clientId = null;
      connected = false;    // Don't reconnect
    };

    this.startBatch = function() {
      batchNesting++;
    };

    this.endBatch = function() {
      if (--batchNesting <= 0)
      {
        batchNesting = 0;
	if (!sending && connected)
	  send();
      }
    };

    // Send (or queue for sending) a message to a channel.
    this.publish = function(channel, message) {
      this.startBatch();
      messagesQueued.push({id: (++sentSeq).toString(), clientId: clientId, channel: channel, data: message});
      this.endBatch();
    };

    // Add callback for channel and tell the server:
    this.subscribe = function(channel, callback) {
      var s = subscriptions[channel];
      if (!s) {
	// First subscription on this channel, tell the server
	subscriptions[channel] = s = [];
	command({channel: '/meta/subscribe', subscription: channel});
      }
      s.push(callback);
    };

    // Remove any occurrence of callback in the subscriptions for channel:
    this.unsubscribe = function(channel, callback) {
      var s = subscriptions[channel];
      if (s) return;
      for (i = s.length-1; i >= 0; i--) {
	if (i in s)
	  s.splice(i, 1);
      }
      if (s.length === 0) {
	// No further subscriptions on this channel, tell the server
	delete subscriptions[channel];
	command({channel: '/meta/unsubscribe', subscription: channel});
      }
    };

    // Low-level wrapper around jQuery's ajax method. Chooses a JSON POST or a JSONP GET.
    ajax = function(messages, successCB, failureCB) {
      var ajaxopts = {
	url: url,
	success: successCB,
	error: failureCB
      };

      if (isCrossDomain)
      {	  // JSONP callback for cross domain
	ajaxopts['dataType'] = 'jsonp';
	ajaxopts['jsonp'] = 'jsonp';
	ajaxopts['data'] = { message: JSON.stringify(messages) };
      }
      else
      {	  // regular AJAX for same domain calls
	ajaxopts['type'] = 'post';
	ajaxopts['data'] = { message: JSON.stringify(messages) };
	// When I do this, messages gets serialised as {"0":{...},"1":{...},...} in Chrome
	// ajaxopts['data'] = messages;
      }
      return $.ajax(ajaxopts);
    };

    // An error has occurred. Record it, and after an increasing timeout, call the function passed:
    backoff = function(func) {
      errorCount++;
      setTimeout(func, errorLastDelay);
      errorLastDelay = errorLastDelay ? errorLastDelay*errorBackoff : errorDelay;
      if (errorLastDelay > errorMaxDelay)
	errorLastDelay = errorMaxDelay;
    };

    // Start, or restart, a poll
    reconnect = function(after_error) {
      if (polling || !connected) return;
      if (after_error)
	backoff(poll);
      else {
	// An error will initially cause an immediate retry, followed by delay and backoff.
	errorCount = 0;
	errorLastDelay = 0;
	poll();
      }
    };

    // Start a long-poll request now.
    poll = function() {
      if (polling)
	return;	  // This can happen during reconnect
      polling = ajax(
	{
	  channel: '/meta/connect',
	  clientId: clientId,
	  id: (++sentSeq).toString(),
	  connectionType: 'long-polling'
	},
	function(message) {	// Success, Process messages and reconnect immediately
	  polling = null;
	  deliver(message);
	  reconnect(message == ""); // On connect failure, message is empty
	},
	function() {		// Error, reconnect after timeout
	  polling = null;
	  reconnect(true);
	}
      );
    };

    // No-op for now; part of the COMET protocol
    advice = function(a) {};

    // Say hello, retrying (with backoff) until we succeed:
    handshake = function() {
      var message = {id: (++sentSeq).toString(), channel: '/meta/handshake', minimumVersion: '0.9', version: '1.0'};

      if (clientId) message['clientId'] = clientId;	// Reconnecting using previous client ID
      ajax(
	message,
	function(messages) {
	  greetz = messages[0];
	  if ((clientId = greetz['clientId'])) {
	    connected = true;
	    if (greetz['advice'])
	      advice(greetz['advice']);
	    if (greetz['successful']) {
	      // Send any subscriptions that already exist
	      $.comet.startBatch();
	      for (var subscription in subscriptions)
		command({channel: '/meta/subscribe', subscription: subscription});
	      $.comet.endBatch();

	      reconnect(false);
	      deliver(messages);
	      for (m in messagesQueued)
		messagesQueued[m].clientId = clientId;	// Ensure outbound messages have clientId
	      $.comet.endBatch();	// Send any messages that were queued waiting for connect
	      return;
	    }
	  }
	  backoff(handshake);	// Keep trying
	},
	function() {		// Handshake connection failure
	  backoff(handshake);	// Try again after timeout
	}
      );
    };

    // Send queued messages. On completion, check and send newly-queued complete message batches
    send = function() {
      var sendAfterPause =
	function() {
	  // Do nothing if another batch was started or someone else sent our messages:
	  var msgcount = messagesQueued.length;
	  if (batchNesting > 0 || msgcount === 0)
	    return;

	  if (receiptSent < receivedSeq)
	    messagesQueued[msgcount-1].confirm = receiptSent = receivedSeq;
	  var messagesToSend = messagesQueued;
	  messagesQueued = [];
	  var resend = function() {
	    sending = null;	// Put the failed messages back in the front of the queue
	    for (i = 0; i < messagesToSend.length; i++) {
	      if (i in messagesToSend)
		messagesQueued.unshift(messagesToSend[i]);
	    }
	    backoff(send);	// Try again later
	  };

	  sending = ajax(
	    messagesToSend,
	    function(messages) {
	      sending = null;
	      if (!deliver(messages))
		resend();
	    },
	    resend // Error occurred
	  );
	};

      // Do the above after a zero timeout in case further messages get synchronously queued:
      setTimeout(sendAfterPause, 0);
    };

    // Deliver the received message to any subscriber on that channel, or to the null (wildcard) channel if none.
    deliver = function(message) {
      var i;
      if (jQuery.isArray(message)) {
	// Deliver each message in the array:
	for (i = 0; i < message.length; i++) {
	  if (i in message)
	    deliver(message[i]);
	}
      } else {
	var a = message['advice'];

	if (a && a['reconnect'] && a['reconnect'] == 'handshake') {
	  // Connection aborted, we're being told to reconnect. Kill any existing long-poll first.
	  if (polling)
	    polling.abort();
	  handshake();
	  return false;
	}

	var id = message['id'];
	if (id && receivedSeq < id)
	  receivedSeq = id;

	var channel = message['channel'];
	var data = message['data'];
	var s = subscriptions[channel] || subscriptions[null];
	if (s && data) {
	  for (i = 0; s && i < s.length; i++) {
	    if (i in s)
	      s[i].call($.comet, message, data, channel);
	  }
	}
      }
      return true;
    };

    // Send a command to a channel:
    command = function(msg) {
      $.comet.startBatch();
      msg.id = (++sentSeq).toString();
      msg.clientId = clientId;
      messagesQueued.push(msg);
      $.comet.endBatch();
    };

    this.clientId = function() { return clientId; };
    this.errorCount = function() { return errorCount; };
  };
})(jQuery);
