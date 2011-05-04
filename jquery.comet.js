/*
 * JQuery COMET (Bayeux protocol) plugin.
 *
 * This implements a bi-direction asynchronous JSON message queueing service.
 * It's rather less gruesome than the original, from the Dojo project.
 *
 * Copyright: Clifford Heath, Data Constellation, http://dataconstellation.com, 2011
 * License: MIT
 *
 * See also http://cometdproject.dojotoolkit.org/
 */
(function($) {
  var Transport = function(url) {
    var isCrossDomain =
      url.substring(0,4) == 'http' &&
      url.substr(7,location.href.length).replace(/\/.*/, '') != location.host;
    var connectionType = isCrossDomain ? 'callback-polling' : 'long-polling';
    var polling = false;	  // We have no active poll yet
    var continuePolling = true;	  // False after this transport is killed
    var advice = null;	  // Server's advice tells us how and whether we should poll

    var self = this;	  // Connect gets called from a callback with wrong "this"
    var connect = function() {
      if (polling)
	return;

      if (advice && advice.reconnect == 'handshake')
      {
	/*
	 * We have to restart with a fresh handshake.
	 * This transport object will be abandoned,
	 * but an existing poll cannot be cancelled without
	 * risk of data loss, so we leave it running, and
	 * just make sure we don't start a new one.
	 */
	continuePolling = false;
	$.comet.renegotiate(url);
	return;
      }

      if (!$.comet.okToPoll)
	return;

      var msg = {
	channel: '/meta/connect',
	clientId: $.comet.clientId, 
	id: String($.comet.nextId()),
	connectionType: connectionType
      };

      polling = true;
      self.send(msg,
	function(responseStr) {
	  var response = (typeof responseStr != "object") ? (eval('(' + responseStr + ')')) : responseStr;
	  polling = false;
	  $.comet.deliver(response);
	  if (continuePolling)
	    reconnect(responseStr.length > 0);
	}
      );
    };

    var reconnect = function(immediately) {
      if (advice)
      {
        if (advice.reconnect == 'none')
	{
	  /*
	   * Server told us not to continue polling.
	   * We can continue sending messages, and
	   * one of the responses we receive might
	   * in future allow polling again.
	   */
	  return;
	}

        if (advice.interval > 0 && !immediately)
	{   // We can connect, but not immediately (had a failure and mustn't go spazz)
          setTimeout(connect, advice.interval);
	  return;
	}
      }
      connect();
    };

    // Receive new advice:
    this.advise = function(new_advice) {
      advice = new_advice;
    };

    this.startPolling = function() {
      reconnect(true);
    };

    this.send = function(msg, responseCB) {
      var defaultCallback = function(responseStr) {
        var response = (typeof responseStr != "object") ? (eval('(' + responseStr + ')')) : responseStr;
        $.comet.deliver(response);
	reconnect(false);
      };

      var successCB = responseCB || defaultCallback;
      var errorCB = function(jqXHR, textStatus, errorThrown) {
	// REVISIT: if msg is an array or msg.channel != '/meta/connect', we have possibly unsent data
	// console.log('failed to connect');
	successCB([]);
      };

      var ajaxopts = {
	url: url,
	success: successCB,
	error: errorCB
      };

      if (connectionType == 'long-polling')
      {	  // regular AJAX for same domain calls
	ajaxopts['type'] = 'post';
	ajaxopts['data'] = { message: JSON.stringify(msg) };
      }
      else
      {	  // JSONP callback for cross domain
	ajaxopts['dataType'] = 'jsonp';
	ajaxopts['jsonp'] = 'jsonp';
	ajaxopts['data'] = { message: JSON.stringify($.extend(msg,{connectionType: 'callback-polling' })) };
      }
      this.pollRequest = $.ajax(ajaxopts);
    };
  };

  $.comet = new function() {
    var	messageQueue = [],
	subscriptions = [],
	subscriptionCallbacks = [],
	batchNest = 0,
	trigger = true,	// this sends $.event.trigger(channel, data)
	transport = null,
	nextId = 0;

    this.okToPoll = false;
    this.clientId = '';

    this.supportedConectionTypes = [ 'long-polling', 'callback-polling' ];

    var handshook = function(responseStr) {
      var response = (typeof responseStr != "object") ? (eval('(' + responseStr + ')')[0]) : responseStr[0];

      if (response.advice)
        transport.advise(response.advice);

      // do version check?
      if (response.successful)
      {
        transport.version = $.comet.version;

        $.comet.clientId = response.clientId;
	$.comet.okToPoll = true;
        transport.startPolling();
	sendMessages();
      }
    };

    this.nextId = function() {
      return nextId++;
    };

    this.init = function(url) {
      transport = new Transport(url || '/cometd');
      this.okToPoll = false;

      var msgHandshake = {
	version: '1.0',
	minimumVersion: '0.9',
	channel: '/meta/handshake',
	id: String(this.nextId())
      };

      transport.send(msgHandshake, handshook);
    };

    this.renegotiate = function(url) {
      transport = null;
      this.init(url);
    };

    var queueMessage = function(msg) {
      messageQueue.push(msg);
      if (batchNest <= 0)
	sendMessages();
    };

    // Arrange to flush the message queue by sending all messages.
    var sendMessages = function() {
      if (!$.comet.okToPoll) return;	// Still in the handshake

      var sendAfterPause =
	function() {
	  if (batchNest > 0 ||	        // oops, another batch was started
	     messageQueue.length === 0)	// Or someone else sent out messages
	    return;

	  // Assign our clientId and a new sequence number to each message in the batch:
	  $(messageQueue).each(function() {
	    this.clientId = String($.comet.clientId);
	    this.id = String($.comet.nextId());
	  });
	  transport.send(messageQueue);
          messageQueue = [];
	};

      // Do the above after a zero timeout in case further messages get synchronously queued:
      setTimeout(sendAfterPause, 0);
    };

    var deliver = function(msg) {
      if (msg.advice)
        transport.advise(msg.advice);

      switch (msg.channel)
      {
      case '/meta/connect':
        // if (msg.successful)
	//   console.log('fruitful poll');
        break;

      // add in subscription handling stuff
      case '/meta/subscribe':
        if (!msg.successful)
          return;
        break;

      case '/meta/unsubscribe':
        if (!msg.successful)
          return;
        break;

      default:
	break;
      }

      if (msg.data)
      {
	if (trigger)
	  $.event.trigger(msg.channel, [msg]);

	var cb = subscriptionCallbacks[msg.channel];
	if (cb)
	  cb(msg);
      }
    };

    // Hold queued messages until the end of the batch
    this.startBatch = function() {
      batchNest++;
    };

    this.endBatch = function() {
      if (--batchNest <= 0)
      {
        batchNest = 0;
        if (messageQueue.length > 0)
          sendMessages();
      }
    };

    // Only one subscription per channel is allowed.
    this.subscribe = function(subscription, responseCB) {
      // if this topic has not been subscribed to yet, send the message now
      if (!subscriptions[subscription])
      {
        subscriptions.push(subscription);
        if (responseCB)
          subscriptionCallbacks[subscription] = responseCB;
        queueMessage({ channel: '/meta/subscribe', subscription: subscription });
      }
      //$.event.add(window, subscription, responseCB);
    };

    this.unsubscribe = function(subscription) {
      queueMessage({ channel: '/meta/unsubscribe', subscription: subscription });
    };

    this.publish = function(channel, msg) {
      queueMessage({channel: channel, data: msg});
    };

    this.deliver = function(response) {
      $(response).each(function() { deliver(this); });
    };

    this.disconnect = function() {
      $(subscriptions).each(function(i) { $.comet.unsubscribe(subscriptions[i]); });
      queueMessage({channel:'/meta/disconnect'});
      transport = null;
    };
  };

})(jQuery);
