#
# Serve the chat demo
#
# Copyright: Clifford Heath, Data Constellation, http://dataconstellation.com, 2011
# License: MIT

# require 'ruby-debug'; Debugger.start

require 'bayeux'

class Bayeux::Client
  attr_accessor :client_name
  attr_accessor :connected
end

class ChatServer < Bayeux
  configure do
    set :public, Sinatra::Application.root+'/../chat_demo'
    # set :tracing, true      # Enable to get Bayeux tracing
  end

  get '/' do
    redirect to('/chat'), 303
  end

  get '/chat' do
    send_file settings.public+'/index.html'
  end

  def send_client_list
    client_names = clients.map{|clientId, client| client.connected ? client.client_name : nil }.compact
    trace "Sending client list: #{client_names.inspect}"
    publish :data => client_names.compact, :channel => '/chat/demo'
  end

  def deliver(message)
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
      unless client
        puts "Message received for unknown client #{clientId}"
        return
      end
      if data['join']
        client.client_name = data['user']
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
