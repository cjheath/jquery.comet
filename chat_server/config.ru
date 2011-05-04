#! /usr/bin/env rackup
#
# Serve the demo using sinatra. To run, just say "rackup"
#
# Magic comment that tells rackup what port to listen on and to use the Thin server (for EM/async_sinatra):
# Note that the released version of rack 1.2.2 does not contain the code that allows --server to be set from here.
#\ --port 8080 --server thin
#
# Copyright: Clifford Heath, Data Constellation, http://dataconstellation.com, 2011
# License: MIT

require 'ruby-debug'
Debugger.start

require 'sinatra'
require 'sinatra/async'
require 'json'
require 'eventmachine'

class ChatServer < Sinatra::Base
  register Sinatra::Async

  enable :show_exceptions

  def initialize *a, &b
    puts "Making new ChatServer: #{object_id}"
    super
  end

  configure do
    set :public, Sinatra::Application.root+'/../chat_demo'
    set :port, 8080
    set :channel, EM::Channel.new
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

  # Deliver a Bayeux message
  def deliver(message)
    if message.is_a?(Array)
      response = []
      message.map do |m|
        response += Array(deliver(m))
      end
      response
    else
      # puts message.inspect
      id = message['id']
      clientId = message['clientId']
      puts "delivering: "+message.inspect
      response =
        case channel_name = message['channel']
        when '/meta/handshake'      # Client says hello, greet them
          clientId = next_client
          puts "Connecting #{clientId} from #{request.ip}"
          {
            :version => '1.0',
            :supportedConnectionTypes => ['long-polling','callback-polling'],
            :successful => true,
            :advice => { :reconnect => 'retry', :interval => 5*1000 },
            :minimumVersion => message['minimumVersion'],
          }

        when '/meta/subscribe'      # Client wants to subscribe to a channel:
          clientId = message['clientId']
          subscription = message['subscription']
          if subscription =~ %r{^/meta/}
            # No-one may subscribe to meta channels.
            # The Bayeux protocol allows server-side clients to (e.g. monitoring apps) but we don't.
            { :successful => false, :error => "500" }
          else
            subscribed_channel = subscription
            puts "Subscribe from #{clientId} to #{subscribed_channel}"
            subscriber_array = channels[subscribed_channel]
            subscriber_array << clientId.to_s unless subscriber_array.include?(clientId.to_s)
            settings.channel.push message   # For (future) monitoring clients
            {
              :successful => true,
              :subscription => subscribed_channel
            }
          end

        when '/meta/unsubscribe'    # Client wants to unsubscribe from a channel:
          clientId = message['clientId']
          subscribed_channel = message['subscription']
          puts "Unsubscribe from #{clientId} to #{subscribed_channel}"
          subscriber_array = channels[subscribed_channel]
          subscriber_array.delete(clientId)
          settings.channel.push message   # For (future) monitoring clients
          {
            :successful => true,
            :subscription => subscribed_channel
          }

        # This is the long-polling request.
        when '/meta/connect'
          puts "#{clientId} is long-polling"
          client_em_subscriptions[clientId.to_s] =
          em_subscription =
            settings.channel.subscribe do |msg|
              if channels[msg[:channel]].include?(clientId)
                puts "Sending pushed message #{msg.inspect}"
                # REVISIT: headers doesn't seem to work here:
                headers({'Content-Type' => 'application/json'})
                connect_response = {
                  :channel => channel_name, :clientId => clientId, :id => id, :successful => true
                }
                body([msg, connect_response].to_json)
              else
                puts "#{clientId} ignores message #{msg.inspect} pushed to unsubscribed channel"
              end
            end
          if em_subscription
            on_close {
              puts "long-poll done, removing EM subscription for #{clientId}"
              settings.channel.unsubscribe(em_subscription)
              client_em_subscriptions.delete(clientId.to_s)
            }
          end
          nil

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

        when '/chat/demo'
          # e.g. message['data'] = {"join"=>true, "chat"=>"cjh has joined", "user"=>"cjh"}
          # e.g.2 {"data"=>{"chat"=>"foo", "user"=>"cjh"}
          puts "#{clientId} says #{message['data']['chat']}"

          settings.channel.push :data => message['data'], :channel => channel_name
          { :successful => true }

        else
          p request
          debugger
          pass  # 404 on their asses
        end

      if response
        response[:channel] = channel_name
        response[:clientId] = clientId
        response[:id] = id
      else
        puts "#{clientId} returning from apost empty-handed (pending!)"
      end
      [response].compact
    end
  end

  get '/' do
    send_file settings.public+'/index.html'
  end

  apost '/cometd' do
    message_json = params['message']
    message = JSON.parse(message_json)
    # p message
    response = deliver(message)
    unless response.empty?
      response_json = response.to_json
      puts 'Responding: '+response_json
      headers({'Content-Type' => 'application/json'})
      body(response_json)
    end
  end

  not_found do
    puts 'Not found: ' + request.url
    'No dice'
  end

end

run ChatServer.new
