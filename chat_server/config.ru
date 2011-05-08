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

require 'chat_server'

# require 'ruby-debug'; Debugger.start

run ChatServer.new
