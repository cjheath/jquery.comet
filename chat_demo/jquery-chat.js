// TODO rewrite with widget factory, moving join/leave etc. to widget methods and init block to init

jQuery(function($) {
  // init
  var username,
    last,
    meta,
    connected = false;
    
  init();
  $(window).unload(leave);
    
  function init() {
    $("#join").show();
    $("#joined").hide();
    $('#phrase').focus();
    $('#altServer').attr('autocomplete', 'OFF');
    
    $("#joinB").click(function(e){
      join();
      e.preventDefault();
    });
    $("#leaveB").click(leave);
    
    $("#username").attr({
      "autocomplete": "OFF"
    }).keyup(function(e){
      if (e.keyCode == 13) {
        join();
        e.preventDefault();
      }
    });
    $("#phrase").attr({
      "autocomplete": "OFF"
    }).keyup(function(e) {
      if (e.keyCode == 13) {
        send();
        e.preventDefault();
      }
    });
    $("#sendB").click(send);
  }
  
  function join() {
    username = $('#username').val();
    if (!username) {
      alert('Please enter a username!');
      return;
    }
    
    var altServer = $('#altServer').val();
    var loc =
      document.location.protocol + "//" +
	(altServer.length > 0 ? altServer : document.location.hostname) +
	":" + document.location.port + "/cometd";
    console.log('comet connecting to '+loc);

    $.comet.connect(loc);
    // For x-domain test change line above to:
    // $.comet.init("http://127.0.0.1:8080/cometd/cometd");
    connected = true;
    
    $("#join").hide();
    $("#joined").show();
    $('#username').focus();
    
    // subscribe and join
    $.comet.startBatch();
    $.comet.subscribe("/chat/demo", receive);
    $.comet.publish("/chat/demo", {
      user: username,
      join: true,
      chat: username + " has joined"
    });
    $.comet.endBatch();
    
    // handle cometd failures while in the room
    if (meta) {
      $.comet.unsubscribe(meta);
    }
    meta = $.comet.subscribe("/cometd/meta", function(e){
      // console.debug(e);
      if (e.action == "handshake") {
        if (e.reestablish) {
          if (e.successful) {
            $.comet.subscribe("/chat/demo", receive);
            $.comet.publish("/chat/demo", {
              user: username,
              join: true,
              chat: username + " has re-joined"
            });
          }
          receive({
            data: {
              join: true,
              user: "SERVER",
              chat: "handshake " + e.successful ? "Handshake OK" : "Failed"
            }
          });
        }
      }
      else 
        if (e.action == "connect") {
          if (e.successful && !connected) {
            receive({
              data: {
                join: true,
                user: "SERVER",
                chat: "reconnected!"
              }
            });
          }
          if (!e.successful && connected) {
            receive({
              data: {
                leave: true,
                user: "SERVER",
                chat: "disconnected!"
              }
            });
          }
          connected = e.successful;
        }
    });
  }
  function send() {
    var phrase = $("#phrase");
    var text = phrase.val();
    phrase.val("");
    
    if (!text || !text.length) {
      return false;
    }
    
    $.comet.publish("/chat/demo", {
      user: username,
      chat: text
    });
  }
  function receive(message) {
    if (!message.data) {
      window.console && console.warn("bad message format " + message);
      return;
    }

    if (message.data instanceof Array)
    {
      var list="";
      for (var i in message.data)
        list+=message.data[i]+"<br/>";
      $('#members').html(list);
    }
    else
    {
      var chat = $('#chat');

      var from = message.data.user;
      var special = message.data.join || message.data.leave;
      var text = message.data.chat;
      if (!text)
      {
        return;
      }
    
    if (!special && from == last) {
      from = "...";
    }
    else {
      last = from;
      from += ":";
    }
    
    if (special) {
      chat.append("<span class=\"alert\"><span class=\"from\">" + from + "&nbsp;</span><span class=\"text\">" + text + "</span></span><br/>");
      last = "";
    }
    else {
      chat.append("<span class=\"from\">" + from + "&nbsp;</span><span class=\"text\">" + text + "</span><br/>");
    }
    // TODO rewrite with jQuery methods
    chat[0].scrollTop = chat[0].scrollHeight - chat[0].clientHeight;
    }
  }
  function leave() {
    if (!username) {
      return;
    }
    
    if (meta) {
      $.comet.unsubscribe(meta);
    }
    meta = null;
    
    $.comet.startBatch();
    $.comet.unsubscribe("/chat/demo", receive);
    $.comet.publish("/chat/demo", {
      user: username,
      leave: true,
      chat: username + " has left"
    });
    $.comet.endBatch();
    
    // switch the input form
    $("#join").show();
    $("#joined").hide();
    $('#username').focus();
    username = null;
    $.comet.disconnect();
    $('#members').html("");
  }
})
