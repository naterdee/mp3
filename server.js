// Get the packages we need
var express = require('express'),
    router = express.Router(),
    mongoose = require('mongoose');

// Read .env file
require('dotenv').config();

// Create our Express application
var app = express();

// Use environment defined port or 3000
var port = process.env.PORT || 3000;

// Allow CORS so that backend and frontend could be put on different servers
var allowCrossDomain = function (req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "X-Requested-With, X-HTTP-Method-Override, Content-Type, Accept");
    res.header("Access-Control-Allow-Methods", "POST, GET, PUT, DELETE, OPTIONS");
    next();
};
app.use(allowCrossDomain);

// Parse URL-encoded and JSON request bodies
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Use routes as a module (see index.js)
require('./routes')(app, router);

// Keep body-parser errors in the same JSON response format as API errors.
app.use(function (err, req, res, next) {
    if (res.headersSent) {
        return next(err);
    }
    var status = err.status === 400 || err.status === 413 ? err.status : 500;
    var message = status === 400
        ? 'Request body contains invalid JSON.'
        : status === 413
            ? 'Request body is too large.'
            : 'An unexpected server error occurred.';
    console.error('Request parsing failed:', err.message);
    res.status(status).json({ message: message, data: null });
});

// Start accepting requests only after MongoDB is ready.
async function start() {
    if (!process.env.MONGODB_URI) {
        console.error('MongoDB connection failed: MONGODB_URI is not set.');
        process.exitCode = 1;
        return;
    }

    try {
        await mongoose.connect(process.env.MONGODB_URI);
    } catch (err) {
        var message = err.message.replace(/mongodb(?:\+srv)?:\/\/[^\s"'<>]+/gi, '[redacted MongoDB URI]');
        console.error('MongoDB connection failed:', err.name + ': ' + message);
        process.exitCode = 1;
        return;
    }

    app.listen(port, function () {
        console.log('MongoDB connected. Server running on port ' + port);
    });
}

start();
