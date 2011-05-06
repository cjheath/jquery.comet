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

require 'bayeux'

# require 'ruby-debug'; Debugger.start

class Bayeux::Client
  attr_accessor :client_name
  attr_accessor :connected
end

class ChatServer < Bayeux
  def initialize *a, &b
    puts "Making new ChatServer: #{object_id}"
    super
  end

  configure do
    set :port, 8080
    # set :tracing, true      # Enable to get Bayeux tracing
  end

  get '/' do
    send_file settings.public+'/index.html'
  end

  def send_client_list
    client_names = clients.map{|clientId, client| client.connected ? client.client_name : nil }.compact
    publish :data => client_names.compact, :channel => '/chat/demo'
  end

  def deliver(message)
    trace "delivering: "+message.inspect

    channel_name = message['channel']

    if channel_name != '/chat/demo'
      # Handle all general Bayeux traffic
      s = super
      send_client_list if channel_name =~ %r{/meta/(un)?subscribe}
      return s
    end

    # Capture the names of clients as they join and maintain connected status
    if data = message['data']
      client = clients[message['clientId']]
      if data['join']
        client.client_name = data['user'] if client
        client.connected = true
      elsif data['leave']
        client.connected = false
      end
    end

    # Broadcast this message to any polling clients:
    publish :data => message['data'], :channel => channel_name

    # and also acknowledge it:
    {
      :successful => true,
      :channel => channel_name,
      :clientId => message['clientId'],
      :id => message['id']
    }
  end

  not_found do
    puts 'Not found: ' + request.url
    'No dice'
  end
end

run ChatServer.new
