// Third-Party Dependencies
var WebSocket           = require('nodejs-websocket');
var express             = require('express');
var app                 = express();
var fs                  = require('fs');
var Cookies             = require('cookies');
var Sha1                = require('./classes/sha1.js');

// Game dependencies
var Chat                = new (require('./chat.js'))();
var Game                = new (require('./game.js'))();
var CommandsController  = new (require('./commandscontroller.js'))();

// Some constants
var ControlPort         = 4001;
var GamePort            = 4000;
var DefaultMapSize      = 15;

// Delete all player files
var rmDir = function(dirPath) {
	try {
		var files = fs.readdirSync(dirPath);
	} catch (e) {
		return;
	}
	if (files.length > 0)
		for (var i = 0; i < files.length; i++) {
			var filePath = dirPath + '/' + files[i];
			if (fs.statSync(filePath).isFile())
				fs.unlinkSync(filePath);
			else
				rmDir(filePath);
		}
	fs.rmdirSync(dirPath);
};
rmDir('./server/players/');
if (!fs.existsSync('./server/players/')){
    fs.mkdirSync('./server/players/');
}

// Create the world directory if it doesn't exist yet
if (!fs.existsSync('./server/worlds/')){
    fs.mkdirSync('./server/worlds/');
}

// Chat Controller Setup
Chat.on('update', function(update) {
    GameSocket.connections.forEach(function(conn) {
        try {
            conn.sendText(JSON.stringify({
                newMessage: update.newMessage,
                messages: update.messages,
                type: 'chat'
            }));
        } catch (e) {
            console.log(e);
        }
    });
});
// Notify other sockets that a player changed his info
Chat.on('playerInfoChanged', function() {
    GameSocket.connections.forEach(function(conn) {
        try {
            conn.sendText(
                JSON.stringify({
                    players: Game.players,
                    type: 'player'
                })
            );
        } catch (e) {
            console.log(e);
        }
    });
});

/*
    Game Controller
*/

// SessionsID's used to identify users over different websocket connections
app.use(express.static('./client', {
    setHeaders: function(res, path) {
        var req = res.req;

        // Get the remote address
        var hashedKey = Sha1.hash((
            req.headers["X-Forwarded-For"] ||
            req.headers["x-forwarded-for"] ||
            req.client.remoteAddress
        ));

        // Response
        res.cookie('sessionID', hashedKey);
    }
}));

app.listen(ControlPort, function() {
    console.log('Control server ready at port ' + ControlPort);
});


var GameSocket = WebSocket.createServer(function (conn) {
    // Extract a permaKey if it's set
    var cookies = conn.headers.cookie;
    var permaKey = cookies.split('sessionID=')[1];

    if (!Game.registerPlayer((permaKey || conn.key))) {
        secureClose(conn);
    }

    // Send down the whole chat
    try {
        conn.sendText(
            JSON.stringify({
                chat: Chat.messages,
                type: 'chat'
            })
        );
    } catch (e) {
        console.log(e);
        secureClose(conn);
    }

    conn.on("text", function (data) {
        try {
            data = JSON.parse(data);
        } catch (e) {
            console.log(e);
            return false;
        }

        switch (data.type) {
            case 'action':
                // Notify the game of the action
                Game.action(
                    data.actionName,
                    (permaKey || conn.key)
                );
                break;
            case 'chat':
                // Notify the chat of the new message
                Chat.write(
                    data.message,
                    Game.playerForKey((permaKey || conn.key))
                );
                break;
            default:

        }
	});

    conn.on("close", function() {
        Game.unregisterPlayer((permaKey || conn.key));
    });

    conn.on('error', function(err) {
        console.log("line 108" + err);
        secureClose(conn);
    });

}).listen(GamePort);

/*
    Game Interaction and Response
*/
Game.clearMap(DefaultMapSize, DefaultMapSize);
Game.verbose = true;

// Notify sockets that the map changed
Game.render = function(game, changedRC) {
    GameSocket.connections.forEach(function(conn, index) {
        // Extract a permaKey if it's set
        var cookies = conn.headers.cookie;
        var permaKey = cookies.split('sessionID=')[1];

        try {
            conn.sendText(
                JSON.stringify({
                    game: {
                        key: (permaKey || conn.key)
                    },
                    map: game.map,
                    players: game.players,
                    changedRC,
                    type: 'game'
                })
            );
        } catch (e) {
            console.log(e);
            secureClose(conn);
        }
    });
}

// Notify sockets that something changed reagarding players
Game.playersChanged = function(players) {
    // Kick and close all connections of dead players
    players.forEach(function(player) {
        if (player) {
            if (player.health === 0) {
                GameSocket.connections.forEach(function(conn, index) {
                    // Extract a permaKey if it's set
                    var cookies = conn.headers.cookie;
                    var permaKey = cookies.split('sessionID=')[1];

                    if ((permaKey || conn.key) === player.key) {
                        conn.close();
                    }
                });
            }
        }
    });

    Chat.fireEvent('playerInfoChanged');
}

/*
    Setup the commands controller
*/
CommandsController.setup(Game, Chat, GameSocket);
CommandsController.startRegistering();

/*
    Securely close the websocket connection without crashing
*/
function secureClose(conn) {
    if (conn.readyState === 1 || conn.readyState === 2) {
        try { conn.close(); } catch (e) { console.log(e); }
    }
}
