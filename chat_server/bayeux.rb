#
# A Bayeux (COMET) server using Async Sinatra. This requires a web server built on EventMachine, such as Thin.
#
# Copyright: Clifford Heath http://dataconstellation.com 2011
# License: MIT
#
require 'sinatra'
require 'sinatra/async'
require 'json'
require 'eventmachine'

class Bayeux < Sinatra::Base
  class Client
    attr_accessor :clientId       # The clientId we assigned
    #attr_accessor :lastSeen       # Timestamp when we last had activity from this client
    attr_accessor :channel        # The EM::Channel on which this client subscribes
    attr_accessor :subscription   # The EM::Subscription if one is currently active
    attr_accessor :queue          # Messages queued for this client

    def initialize clientId
      @clientId = clientId
      @channel = EM::Channel.new
      @queue = []
    end

    def flush sinatra
      queued = @queue
      sinatra.trace "Sending to #{@clientId}: #{queued.inspect}"
      @queue = []
      sinatra.headers({'Content-Type' => 'application/json'})
      sinatra.body(queued.to_json)
    end
  end

  register Sinatra::Async

  enable :show_exceptions

  def initialize *a, &b
    super
  end

  configure do
    set :public, Sinatra::Application.root+'/../chat_demo'
    set :tracing, false      # Enable to get Bayeux tracing
  end

  def trace s
    puts s if settings.tracing
  end

  # Sinatra dup's this object, so we have to use class variables
  # Each channel keeps a list of subscribed clients
  def channels
    @@channels ||= Hash.new {|h, k| h[k] = [] }
  end

  def clients
    @@clients ||= {}
  end

  # ClientIds should be strong random numbers containing at least 128 bits of entropy. These aren't!
  def next_client_id
    @@next_client_id ||= 0
    (@@next_client_id += 1).to_s
  end

  def publish message
    channel = message['channel'] || message[:channel]
    clients = channels[channel]
    trace "publishing to #{channel} with #{clients.size} subscribers: #{message.inspect}"
    clients.each do | client|
      trace "Client #{client.clientId} will receive #{message.inspect}"
      client.queue << message
      client.channel.push true    # Wake up the subscribed client
    end
  end

  def handshake message
    publish :channel => '/cometd/meta', :data => {}, :action => "handshake", :reestablish => false, :successful => true
    publish :channel => '/cometd/meta', :data => {}, :action => "connect", :successful => true
    {
      :version => '1.0',
      :supportedConnectionTypes => ['long-polling','callback-polling'],
      :successful => true,
      :advice => { :reconnect => 'retry', :interval => 5*1000 },
      :minimumVersion => message['minimumVersion'],
    }
  end

  def subscribe message
    clientId = message['clientId']
    subscription = message['subscription']
    if subscription =~ %r{^/meta/}
      # No-one may subscribe to meta channels.
      # The Bayeux protocol allows server-side clients to (e.g. monitoring apps) but we don't.
      trace "Client #{clientId} may not subscribe to #{subscription}"
      { :successful => false, :error => "500" }
    else
      subscribed_channel = subscription
      trace "Client #{clientId} wants messages from #{subscribed_channel}"
      client_array = channels[subscribed_channel]
      client = clients[clientId]
      if client and !client_array.include?(client)
        client_array << client
      end
      publish message
      {
        :successful => true,
        :subscription => subscribed_channel
      }
    end
  end

  def unsubscribe message
    clientId = message['clientId']
    subscribed_channel = message['subscription']
    trace "Client #{clientId} no longer wants messages from #{subscribed_channel}"
    client_array = channels[subscribed_channel]
    client = clients[clientId]
    client_array.delete(client)
    publish message
    {
      :successful => true,
      :subscription => subscribed_channel
    }
  end

  def connect message
    clientId = message['clientId']
    trace "Client #{clientId} is long-polling"
    client = clients[clientId]
    pass unless client        # Or "not authorised", or "handshake"?

    connect_response = {
      :channel => '/meta/connect', :clientId => clientId, :id => message['id'], :successful => true
    }

    queued = client.queue
    if !queued.empty?
      client.queue << connect_response
      client.flush(self)
      return
    end

    client.subscription =
      client.channel.subscribe do |msg|
        queued = client.queue
        if !queued.empty?
          client.queue << connect_response
          client.flush(self)
        else
          trace "Client #{clientId} awoke but found an empty queue"
        end
      end

    if client.subscription
      trace "Client #{clientId} is waiting on #{client.subscription}"
      on_close {
        trace "long-poll done, removing EM subscription for #{clientId}"
        client.channel.unsubscribe(client.subscription)
        client.subscription = nil
      }
    else
      trace "Client #{clientId} failed to wait"
    end
    nil
  end

  def disconnect message
    clientId = message['clientId']
    if client = clients[clientId]
      # Kill an outstanding poll:
      EM::schedule {
        client.channel.unsubscribe(client.subscription) if client.subscription
        client.subscription = nil
        clients.delete(clientId)
      }
      { :successful => true }
    else
      { :successful => false }
    end
  end

  def deliver(message)
    id = message['id']
    clientId = message['clientId']
    channel_name = message['channel']

    response =
      case channel_name
      when '/meta/handshake'      # Client says hello, greet them
        clientId = next_client_id
        clients[clientId] = Client.new(clientId)
        trace "Client #{clientId} offers a handshake from #{request.ip}"
        handshake message

      when '/meta/subscribe'      # Client wants to subscribe to a channel:
        subscribe message

      when '/meta/unsubscribe'    # Client wants to unsubscribe from a channel:
        unsubscribe message

      # This is the long-polling request.
      when '/meta/connect'
        connect message

      when '/meta/disconnect'
        disconnect message

      # Other meta channels are disallowed
      when %r{/meta/(.*)}
        trace "Client #{clientId} tried to send a message to #{channel_name}"
        { :successful => false }

      # Service channels default to no-op. Service messages are never broadcast.
      when %r{/service/(.*)}
        trace "Client #{clientId} sent a private message to #{channel_name}"
        { :successful => true }

      else
        puts "Unknown channel in request: "+message
        pass  # 404
      end

    # Set the standard parameters for all response messages
    if response
      response[:channel] = channel_name
      response[:clientId] = clientId
      response[:id] = id
      [response]
    else
      []
    end
  end

  # Deliver a Bayeux message
  def deliver_all(message)
    begin
      if message.is_a?(Array)
        response = []
        message.map do |m|
          response += [deliver(m)].flatten
        end
        response
      else
        Array(deliver(message))
      end
    rescue NameError    # Usually an "Uncaught throw" from calling pass
      raise
    rescue => e
      puts "#{e.class.name}: #{e.to_s}\n#{e.backtrace*"\n\t"}"
    end
  end

  apost '/cometd' do
    # This code corrects for JSON serialisation bugs in Chrome,
    # where an array gets serialised as an object. For now, I'm
    # continuing to use json2.js, which does it properly.
    #
    #message = params['message']
    #if message.is_a?(Hash) and message["0"]
    #  message = message.keys.sort_by{|k| k.to_i}.inject([]) { |a, k| a << message[k] }
    #end

    message_json = params['message']
    message = JSON.parse(message_json)
    response = deliver_all(message)
    unless response.empty?
      response_json = response.to_json
      trace 'Responding: ' + response.map{|m| m.to_json}*"\n\t"
      headers({'Content-Type' => 'application/json'})
      body(response_json)
    end
  end

end
