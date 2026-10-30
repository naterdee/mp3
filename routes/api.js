var mongoose = require('mongoose');
var User = require('../models/user');
var Task = require('../models/task');

var objectIdPattern = /^[a-f\d]{24}$/i;

function apiError(status, message) {
    var error = new Error(message);
    error.status = status;
    return error;
}

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireBody(body) {
    if (!isObject(body)) {
        throw apiError(400, 'Request body must be a JSON object.');
    }
    return body;
}

function requiredString(value, field) {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw apiError(400, field + ' is required and must be a non-empty string.');
    }
    return value.trim();
}

function optionalString(value, field, defaultValue) {
    if (value === undefined) {
        return defaultValue;
    }
    if (typeof value !== 'string') {
        throw apiError(400, field + ' must be a string.');
    }
    return value;
}

function parseId(value, field) {
    if (typeof value !== 'string' || !objectIdPattern.test(value)) {
        throw apiError(400, field + ' must be a valid ID.');
    }
    return new mongoose.Types.ObjectId(value).toString();
}

function parseDate(value, field) {
    if (!(typeof value === 'string' || value instanceof Date)) {
        throw apiError(400, field + ' must be a valid date.');
    }
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        throw apiError(400, field + ' must be a valid date.');
    }
    return date;
}

function parseJsonObject(value, field, defaultValue) {
    if (value === undefined) {
        return defaultValue;
    }

    var parsed = value;
    if (typeof value === 'string') {
        try {
            parsed = JSON.parse(value);
        } catch (error) {
            throw apiError(400, field + ' must contain valid JSON.');
        }
    }
    if (!isObject(parsed)) {
        throw apiError(400, field + ' must be a JSON object.');
    }
    return parsed;
}

function parseProjection(value) {
    var projection = parseJsonObject(value, 'select', undefined);
    if (projection === undefined) {
        return undefined;
    }
    Object.keys(projection).forEach(function (field) {
        if (projection[field] !== 0 && projection[field] !== 1) {
            throw apiError(400, 'select values must be 0 or 1.');
        }
    });
    return projection;
}

function parseSort(value) {
    var sort = parseJsonObject(value, 'sort', undefined);
    if (sort === undefined) {
        return undefined;
    }
    Object.keys(sort).forEach(function (field) {
        if (sort[field] !== 1 && sort[field] !== -1) {
            throw apiError(400, 'sort values must be 1 or -1.');
        }
    });
    return sort;
}

function parseNonNegativeInteger(value, field, defaultValue) {
    if (value === undefined) {
        return defaultValue;
    }
    var number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0) {
        throw apiError(400, field + ' must be a non-negative integer.');
    }
    return number;
}

function parseBoolean(value, field, defaultValue) {
    if (value === undefined) {
        return defaultValue;
    }
    if (value === true || value === 'true') {
        return true;
    }
    if (value === false || value === 'false') {
        return false;
    }
    throw apiError(400, field + ' must be true or false.');
}

function parseUserInput(body) {
    body = requireBody(body);
    var name = requiredString(body.name, 'name');
    var email = requiredString(body.email, 'email');
    var pendingTasks = body.pendingTasks === undefined ? [] : body.pendingTasks;

    if (!Array.isArray(pendingTasks)) {
        throw apiError(400, 'pendingTasks must be an array of task IDs.');
    }

    var uniqueTasks = [];
    var seen = new Set();
    pendingTasks.forEach(function (taskId) {
        taskId = parseId(taskId, 'Each pendingTasks entry');
        if (!seen.has(taskId)) {
            uniqueTasks.push(taskId);
            seen.add(taskId);
        }
    });

    return { name: name, email: email, pendingTasks: uniqueTasks };
}

function parseTaskInput(body) {
    body = requireBody(body);
    var name = requiredString(body.name, 'name');
    var deadline = parseDate(body.deadline, 'deadline');
    var description = optionalString(body.description, 'description', '');
    var completed = body.completed === undefined ? false : body.completed;
    if (typeof completed !== 'boolean') {
        throw apiError(400, 'completed must be a boolean.');
    }

    var assignedUser = body.assignedUser === undefined ? '' : body.assignedUser;
    if (typeof assignedUser !== 'string') {
        throw apiError(400, 'assignedUser must be a valid user ID or an empty string.');
    }
    if (assignedUser !== '') {
        assignedUser = parseId(assignedUser, 'assignedUser');
    }

    var assignedUserName = optionalString(body.assignedUserName, 'assignedUserName', undefined);
    if (assignedUser === '') {
        if (assignedUserName !== undefined && assignedUserName !== 'unassigned') {
            throw apiError(400, 'An unassigned task must use assignedUserName "unassigned".');
        }
        assignedUserName = 'unassigned';
    }

    return {
        name: name,
        description: description,
        deadline: deadline,
        completed: completed,
        assignedUser: assignedUser,
        assignedUserName: assignedUserName
    };
}

async function transaction(callback) {
    var session = await mongoose.startSession();
    try {
        var result;
        await session.withTransaction(async function () {
            result = await callback(session);
        });
        return result;
    } finally {
        await session.endSession();
    }
}

async function findTasksForUser(pendingTasks, session) {
    if (pendingTasks.length === 0) {
        return [];
    }
    var tasks = await Task.find({ _id: { $in: pendingTasks } }).session(session);
    if (tasks.length !== pendingTasks.length) {
        throw apiError(404, 'One or more referenced tasks were not found.');
    }
    if (tasks.some(function (task) { return task.completed; })) {
        throw apiError(400, 'Completed tasks cannot be added to pendingTasks.');
    }
    return tasks;
}

async function validateEmail(email, userId, session) {
    var filter = { email: email };
    if (userId) {
        filter._id = { $ne: userId };
    }
    if (await User.exists(filter).session(session)) {
        throw apiError(400, 'That email address is already in use.');
    }
}

function sendError(error, req, res, next) {
    if (res.headersSent) {
        return next(error);
    }
    if (error.code === 11000) {
        return res.status(400).json({
            message: 'That email address is already in use.',
            data: null
        });
    }
    var status = error.status;
    if (!status && (error.name === 'ValidationError' || error.name === 'CastError' || error.name === 'SyntaxError')) {
        status = 400;
    }
    if (!status || status < 400 || status > 599) {
        status = 500;
    }
    var message = status === 500 ? 'An unexpected server error occurred.' : error.message;
    console.error('API request failed:', error.message);
    return res.status(status).json({ message: message, data: null });
}

function ensureUrlId(id) {
    if (!objectIdPattern.test(id)) {
        throw apiError(404, 'The requested resource was not found.');
    }
    return new mongoose.Types.ObjectId(id);
}

module.exports = function (router) {
    router.get('/', function (req, res) {
        res.json({ message: 'API is running.', data: null });
    });

    router.get('/users', async function (req, res) {
        var where = parseJsonObject(req.query.where, 'where', {});
        var sort = parseSort(req.query.sort);
        var select = parseProjection(req.query.select);
        var skip = parseNonNegativeInteger(req.query.skip, 'skip', 0);
        var hasLimit = req.query.limit !== undefined;
        var limit = parseNonNegativeInteger(req.query.limit, 'limit', undefined);
        var count = parseBoolean(req.query.count, 'count', false);

        if (count) {
            var userCount = await User.countDocuments(where);
            return res.json({ message: 'OK', data: userCount });
        }

        var query = User.find(where);
        if (sort) query = query.sort(sort);
        if (select) query = query.select(select);
        if (skip) query = query.skip(skip);
        if (hasLimit) query = query.limit(limit);
        var users = await query.exec();
        return res.json({ message: 'OK', data: users });
    });

    router.post('/users', async function (req, res) {
        var input = parseUserInput(req.body);
        var requestedId;
        if (req.body._id !== undefined) {
            requestedId = parseId(req.body._id, '_id');
        }

        var user = await transaction(async function (session) {
            await validateEmail(input.email, null, session);
            await findTasksForUser(input.pendingTasks, session);

            var created = new User({
                _id: requestedId,
                name: input.name,
                email: input.email,
                pendingTasks: input.pendingTasks
            });
            await created.save({ session: session });

            if (input.pendingTasks.length) {
                await User.updateMany(
                    { _id: { $ne: created._id }, pendingTasks: { $in: input.pendingTasks } },
                    { $pull: { pendingTasks: { $in: input.pendingTasks } } },
                    { session: session }
                );
                await Task.updateMany(
                    { _id: { $in: input.pendingTasks } },
                    { $set: { assignedUser: created._id.toString(), assignedUserName: created.name } },
                    { session: session }
                );
            }
            return created;
        });
        return res.status(201).json({ message: 'User created successfully.', data: user });
    });

    router.get('/users/:id', async function (req, res) {
        var id = ensureUrlId(req.params.id);
        var select = parseProjection(req.query.select);
        var query = User.findById(id);
        if (select) query = query.select(select);
        var user = await query.exec();
        if (!user) {
            throw apiError(404, 'The requested user was not found.');
        }
        return res.json({ message: 'OK', data: user });
    });

    router.put('/users/:id', async function (req, res) {
        var id = ensureUrlId(req.params.id);
        var input;
        var updated = await transaction(async function (session) {
            var current = await User.findById(id).session(session);
            if (!current) {
                throw apiError(404, 'The requested user was not found.');
            }
            input = parseUserInput(req.body);
            await validateEmail(input.email, current._id, session);
            await findTasksForUser(input.pendingTasks, session);

            var oldPendingTasks = current.pendingTasks;
            var newSet = new Set(input.pendingTasks);

            await User.updateMany(
                { _id: { $ne: current._id }, pendingTasks: { $in: input.pendingTasks } },
                { $pull: { pendingTasks: { $in: input.pendingTasks } } },
                { session: session }
            );
            await Task.updateMany(
                { assignedUser: current._id.toString() },
                { $set: { assignedUserName: input.name } },
                { session: session }
            );

            var removedTasks = oldPendingTasks.filter(function (taskId) { return !newSet.has(taskId); });
            if (removedTasks.length) {
                await Task.updateMany(
                    { _id: { $in: removedTasks }, assignedUser: current._id.toString() },
                    { $set: { assignedUser: '', assignedUserName: 'unassigned' } },
                    { session: session }
                );
            }
            if (input.pendingTasks.length) {
                await Task.updateMany(
                    { _id: { $in: input.pendingTasks } },
                    { $set: { assignedUser: current._id.toString(), assignedUserName: input.name } },
                    { session: session }
                );
            }

            current.name = input.name;
            current.email = input.email;
            current.pendingTasks = input.pendingTasks;
            await current.save({ session: session });
            return current;
        });
        return res.json({ message: 'User updated successfully.', data: updated });
    });

    router.delete('/users/:id', async function (req, res) {
        var id = ensureUrlId(req.params.id);
        await transaction(async function (session) {
            var user = await User.findById(id).session(session);
            if (!user) {
                throw apiError(404, 'The requested user was not found.');
            }
            await Task.updateMany(
                { assignedUser: user._id.toString() },
                { $set: { assignedUser: '', assignedUserName: 'unassigned' } },
                { session: session }
            );
            await User.deleteOne({ _id: user._id }, { session: session });
        });
        return res.status(204).end();
    });

    router.get('/tasks', async function (req, res) {
        var where = parseJsonObject(req.query.where, 'where', {});
        var sort = parseSort(req.query.sort);
        var select = parseProjection(req.query.select);
        var skip = parseNonNegativeInteger(req.query.skip, 'skip', 0);
        var limit = parseNonNegativeInteger(req.query.limit, 'limit', 100);
        var count = parseBoolean(req.query.count, 'count', false);

        if (count) {
            var taskCount = await Task.countDocuments(where);
            return res.json({ message: 'OK', data: taskCount });
        }

        var query = Task.find(where);
        if (sort) query = query.sort(sort);
        if (select) query = query.select(select);
        if (skip) query = query.skip(skip);
        query = query.limit(limit);
        var tasks = await query.exec();
        return res.json({ message: 'OK', data: tasks });
    });

    router.post('/tasks', async function (req, res) {
        var input = parseTaskInput(req.body);
        var task = await transaction(async function (session) {
            var assignedUser;
            if (input.assignedUser) {
                assignedUser = await User.findById(input.assignedUser).session(session);
                if (!assignedUser) {
                    throw apiError(404, 'The assigned user was not found.');
                }
                if (input.assignedUserName !== undefined && input.assignedUserName !== assignedUser.name) {
                    throw apiError(400, 'assignedUserName must match the assigned user.');
                }
                input.assignedUserName = assignedUser.name;
            }

            var created = new Task(input);
            await created.save({ session: session });
            if (assignedUser && !created.completed) {
                await User.updateOne(
                    { _id: assignedUser._id },
                    { $addToSet: { pendingTasks: created._id.toString() } },
                    { session: session }
                );
            }
            return created;
        });
        return res.status(201).json({ message: 'Task created successfully.', data: task });
    });

    router.get('/tasks/:id', async function (req, res) {
        var id = ensureUrlId(req.params.id);
        var select = parseProjection(req.query.select);
        var query = Task.findById(id);
        if (select) query = query.select(select);
        var task = await query.exec();
        if (!task) {
            throw apiError(404, 'The requested task was not found.');
        }
        return res.json({ message: 'OK', data: task });
    });

    router.put('/tasks/:id', async function (req, res) {
        var id = ensureUrlId(req.params.id);
        var updated = await transaction(async function (session) {
            var current = await Task.findById(id).session(session);
            if (!current) {
                throw apiError(404, 'The requested task was not found.');
            }
            var input = parseTaskInput(req.body);
            var assignedUser;
            if (input.assignedUser) {
                assignedUser = await User.findById(input.assignedUser).session(session);
                if (!assignedUser) {
                    throw apiError(404, 'The assigned user was not found.');
                }
                if (input.assignedUserName !== undefined && input.assignedUserName !== assignedUser.name) {
                    throw apiError(400, 'assignedUserName must match the assigned user.');
                }
                input.assignedUserName = assignedUser.name;
            }

            if (current.assignedUser) {
                await User.updateOne(
                    { _id: current.assignedUser },
                    { $pull: { pendingTasks: current._id.toString() } },
                    { session: session }
                );
            }

            current.name = input.name;
            current.description = input.description;
            current.deadline = input.deadline;
            current.completed = input.completed;
            current.assignedUser = input.assignedUser;
            current.assignedUserName = input.assignedUserName;
            await current.save({ session: session });

            if (assignedUser && !current.completed) {
                await User.updateOne(
                    { _id: assignedUser._id },
                    { $addToSet: { pendingTasks: current._id.toString() } },
                    { session: session }
                );
            }
            return current;
        });
        return res.json({ message: 'Task updated successfully.', data: updated });
    });

    router.delete('/tasks/:id', async function (req, res) {
        var id = ensureUrlId(req.params.id);
        await transaction(async function (session) {
            var task = await Task.findById(id).session(session);
            if (!task) {
                throw apiError(404, 'The requested task was not found.');
            }
            if (task.assignedUser) {
                await User.updateOne(
                    { _id: task.assignedUser },
                    { $pull: { pendingTasks: task._id.toString() } },
                    { session: session }
                );
            }
            await Task.deleteOne({ _id: task._id }, { session: session });
        });
        return res.status(204).end();
    });

    router.use(sendError);
    return router;
};
