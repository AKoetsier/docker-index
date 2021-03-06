var _ = require('underscore');
var async = require('async');
var crypto = require('crypto');
var restify = require('restify');
var util = require('util');
var request = require('request');

module.exports = function(config, redis, logger) {

  var endpoints = {};

  endpoints.listWebhooks = function (req, res, next) {
    if (!req.params.namespace)
      req.params.namespace = 'library';

    var webhooks_key = util.format('webhooks:%s_%s', req.params.namespace, req.params.repo);

    redis.smembers(webhooks_key, function(err, webhooks) {
      next.ifError(err);

      var all_webhooks = [];

      async.eachSeries(webhooks, function(webhook, callback) {
        var webhook_key = util.format('webhooks:%s_%s:%s', req.params.namespace, req.params.repo, webhook)
        redis.hgetall(webhook_key, function(err, hook) {
          if (err) return callback(err);          
          if (hook)
            all_webhooks.push(hook);
          callback(null);
        });
      }, function(err) {
        next.ifError(err);
        res.send(200, all_webhooks);
        return next();
      });
    })
  };

  endpoints.addWebhook = function (req, res, next) {
    if (!req.params.namespace)
      req.params.namespace = 'library';

    var ALLOWED = ['new', 'existing'];

    if (!req.body.events)
      req.body.events = ['new'];

    for (var i=0; i<req.body.events.length; i++) {
      if (ALLOWED.indexOf(req.body.events[i]) == -1) {
        return next(new restify.InvalidArgumentError(util.format('%s event is not supported', req.body.events[i])));
      }
    }

    var webhooks_key = util.format('webhooks:%s_%s', req.params.namespace, req.params.repo);
    var webhook_id = crypto.createHash('sha1').update(req.body.url).digest('hex');
    var webhook_key = util.format('webhooks:%s_%s:%s', req.params.namespace, req.params.repo, webhook_id);
    var webhook_events = req.body.events;

    var new_event = req.body.events.indexOf('new') !== -1 ? 'true' : 'false';
    var existing_event = req.body.events.indexOf('existing') !== -1 ? 'true' : 'false';

    redis.exists(webhook_key, function(err, exists) {
      next.ifError(err);

      if (exists) {
        res.send(409, {message: 'webhook exists'});
        return next();
      }

      async.series([
        // Set the ID
        function(callback) {
          redis.hset(webhook_key, 'id', webhook_id, function(err, result) {
            if (err) return callback(err);
            callback(null);
          });
        },
        // Set the URL
        function(callback) {
          redis.hset(webhook_key, 'url', req.body.url, function(err, result) {
            if (err) return callback(err);
            callback(null);
          });
        },
        // Set the New Events
        function(callback) {
          redis.hset(webhook_key, 'new', new_event, function(err, result) {
            if (err) return callback(err);
            callback(null);
          });
        },
        // Set the Existing Event
        function(callback) {
          redis.hset(webhook_key, 'existing', existing_event, function(err, result) {
            if (err) return callback(err);
            callback(null);
          });
        },
        function(callback) {
          redis.hset(webhook_key, 'active', 1, function(err, result) {
            if (err) return callback(err);
            callback(null);
          });
        }
      ], function(err) {
        next.ifError(err);

        redis.sadd(webhooks_key, webhook_id, function(err) {
          next.ifError(err);
          
          res.send(201, {message: 'webhook created', 'id': webhook_id, 'events': webhook_events});
          return next();
        });
      });
    });
  };
  
  endpoints.removeWebhook = function (req, res, next) {
    if (!req.params.namespace)
      req.params.namespace = 'library';

    var webhooks_key = util.format('webhooks:%s_%s', req.params.namespace, req.params.repo);
    var webhook_id = req.params.id;
    var webhook_key = util.format('webhooks:%s_%s:%s', req.params.namespace, req.params.repo, webhook_id);

    redis.exists(webhook_key, function(err, exists) {
      next.ifError(err);

      if (exists) {
        redis.srem(webhooks_key, webhook_id, function(err, success) {
          next.ifError(err);

          redis.del(webhook_key, function(err, success) {
            next.ifError(err);
        
            res.send(200, {message: 'webhook deleted', id: webhook_id});
            return next();
          })
        });
      } 
      else {
        res.send(404, {message: 'webhook does not exist'});
        return next(); 
      }      
    });
  };

  endpoints.removeWebhookAll = function (req, res, next) {
    if (!req.params.namespace)
      req.params.namespace = 'library';
    
    var webhooks_key = util.format('webhooks:%s_%s', req.params.namespace, req.params.repo);

    redis.smembers(webhooks_key, function(err, webhooks) { 
      next.ifError(err);
      
      async.eachSeries(webhooks, function(webhook, callback) {
        redis.del(webhook, function(err, success) {
          if (err) return callback(err);
          
          callback(null);
        })
      }, function (err) {
        next.ifError(err);
        
        redis.del(webhooks_key, function(err, success) {
          next.ifError(err);

          res.send(200, {message: 'webhooks deleted'});
          return next();
        });
      });
    });
  };

  endpoints.pingWebhook = function (req, res, next) {
    var webhook_key = util.format('webhooks:%s_%s:%s', req.params.namespace, req.params.repo, req.params.id);

    redis.hgetall(webhook_key, function(err, webhook) {
      next.ifError(err);

      if (webhook == null) {
        res.send(404, {message: 'webhook not found'})
        return next();
      }

      var payload = {
        id: webhook.id,
        config: webhook
      };
      
      request.post({
        url: webhook.url,
        timeout: config.webhooks.timeout,
        json: true,
        body: payload
      }, function(err, response, body) {
        next.ifError(err);

        if (res.statusCode == 200) {
          res.send(200, {body: body});
          return next();
        }
        
        res.send(409);
        return next();
      });
    })
  };

  return endpoints;

};

