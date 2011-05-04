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
  register Sinatra::Async

  enable :show_exceptions

  def initialize *a, &b
    super
  end

  configure do
    set :public, Sinatra::Application.root+'/../chat_demo'
    set :channel, EM::Channel.new
    set :tracing, false
  end

  def trace s
    puts s if settings.tracing
  end

  # Sinatra dup's this object, so we have to use class variables
  # Each channel keeps a list of subscribed clientId's
  def channels
    @@channels ||= Hash.new {|h, k| h[k] = [] }
  end

  # Each client has at most one EventMachine subscription
  def client_em_subscriptions
    @@client_em_subscriptions ||= {}
  end

  # ClientIds should be strong random numbers containing at least 128 bits of entropy. These aren't!
  def next_client
    @@next_client ||= 0
    (@@next_client += 1).to_s
  end

  def handshake message
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
      { :successful => false, :error => "500" }
    else
      subscribed_channel = subscription
      trace "Subscribe from #{clientId} to #{subscribed_channel}"
      subscriber_array = channels[subscribed_channel]
      subscriber_array << clientId.to_s unless subscriber_array.include?(clientId.to_s)
      settings.channel.push message   # For (future) monitoring clients
      {
        :successful => true,
        :subscription => subscribed_channel
      }
    end
  end

  def unsubscribe message
    clientId = message['clientId']
    subscribed_channel = message['subscription']
    trace "Unsubscribe from #{clientId} to #{subscribed_channel}"
    subscriber_array = channels[subscribed_channel]
    subscriber_array.delete(clientId)
    settings.channel.push message   # For (future) monitoring clients
    {
      :successful => true,
      :subscription => subscribed_channel
    }
  end

  def connect message
    clientId = message['clientId']
    trace "#{clientId} is long-polling"
    client_em_subscriptions[clientId.to_s] =
    em_subscription =
      settings.channel.subscribe do |msg|
        if channels[msg[:channel]].include?(clientId)
          trace "Sending pushed message #{msg.inspect}"
          # REVISIT: headers doesn't seem to work here:
          headers({'Content-Type' => 'application/json'})
          connect_response = {
            :channel => '/meta/connect', :clientId => clientId, :id => message['id'], :successful => true
          }
          body([msg, connect_response].to_json)
        else
          trace "#{clientId} ignores message #{msg.inspect} pushed to unsubscribed channel"
        end
      end
    if em_subscription
      on_close {
        trace "long-poll done, removing EM subscription for #{clientId}"
        settings.channel.unsubscribe(em_subscription)
        client_em_subscriptions.delete(clientId.to_s)
      }
    end
    nil
  end

  def deliver(message)
    id = message['id']
    clientId = message['clientId']
    channel_name = message['channel']

    response =
      case channel_name
      when '/meta/handshake'      # Client says hello, greet them
        clientId = next_client
        trace "Connecting #{clientId} from #{request.ip}"
        handshake message

      when '/meta/subscribe'      # Client wants to subscribe to a channel:
        subscribe message

      when '/meta/unsubscribe'    # Client wants to unsubscribe from a channel:
        unsubscribe message

      # This is the long-polling request.
      when '/meta/connect'
        connect message

      # Other meta channels are disallowed
      when %r{/meta/(.*)}
        { :successful => false }

      # Service channels default to no-op. Service messages are never broadcast.
      when %r{/service/(.*)}
        { :successful => true }

      when '/meta/disconnect'
        if em_subscription = client_em_subscriptions.delete(clientId.to_s)
          settings.channel.unsubscribe(em_subscription)
        end
        { :successful => !!em_subscription }

      else
        puts "Unknown channel in request: "+request.inspect
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
    if message.is_a?(Array)
      response = []
      message.map do |m|
        response += Array(deliver(m))
      end
      response
    else
      Array(deliver(message))
    end
  end

  apost '/cometd' do
    message_json = params['message']
    message = JSON.parse(message_json)
    response = deliver_all(message)
    unless response.empty?
      response_json = response.to_json
      trace 'Responding: '+response_json
      headers({'Content-Type' => 'application/json'})
      body(response_json)
    end
  end

end
