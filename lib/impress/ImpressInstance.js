const
  DEFAULT_PHANTOM_EXEC_TIMEOUT = 20000,
  DEFAULT_IMPRESS_MAX_CONTENT_LENGTH = 2097152,
  MIN_INVOKE_INTERVAL = 500,
  OK_EXIT_CODE = 0
  ;

var
  path = require('path'),
  exec = require('child_process').exec,
  HtmlCompressor = require('../html/HtmlCompressor')
  ;

module.exports = ImpressInstance;

function ImpressInstance(deferred, options) {
  options = options || {};

  this.args = {
    "--ignore-ssl-errors": 'true',
    "--ssl-protocol": 'tlsv1'
  };

  this.binary = options.phantomBinary || path.join(__dirname, '../../phantomjs/binary/phantomjs');
  this.scriptPath = options.phantomScript || path.join(__dirname, '../../phantomjs/impress.js');
  this.execTimeout = options.phantomExecTimeout || DEFAULT_PHANTOM_EXEC_TIMEOUT;
  this.maxContentLength = options.impressMaxContentLength || DEFAULT_IMPRESS_MAX_CONTENT_LENGTH;
  this.notices = options.impressNotices;
  this.warnings = options.impressWarnings;

  this.timeout = deferred.timeout - (Date.now() - deferred.createdTime);
  this.execTimeout = Math.min(this.execTimeout, this.timeout);

  if (options.phantomArgs) {
    this.addArgs(options.phantomArgs);
  }

  this.deferred = deferred;
}

ImpressInstance.prototype = {

  destroy: function() {
    this.deferred = undefined;
  },

  addArgs: function(args) {
    var
      collection = {},
      self = this
      ;

    if (!args) {
      return
    }

    if (typeof args == 'object') {
      if (Array.isArray(args)) {
        args.forEach(function(arg) {
          var
            parts = arg.split('=');
          collection[parts[0]] = String(parts[1] || '');
        })
      }
      else {
        Object.keys(args).forEach(function(key) {
          collection[key] = String(args[key]);
        });
      }
    }
    else if (typeof args == 'string') {
      args = args.replace(/\s*=\s*/g, '=');
      args.split(/\s+/).forEach(function(arg) {
        var
          parts;
        if (arg) {
          parts = String(arg).split('=');
          collection[parts[0]] = String(parts[1] || '');
        }
      });
    }

    Object.keys(collection).forEach(function(key) {
      var
        arg = collection[key];

      if (!/^--[^-]/.test(key)) {
        if (key[0] == '-') {
          key = key.slice(1);
        }
        key = '--' + key;
      }
      self.args[key] = arg;
    });

    return this.args;
  },

  _getCommandExecString: function(base64EncodedUrl) {
    var
      args = this.args,
      builder;

    if (typeof base64EncodedUrl == 'undefined') {
      base64EncodedUrl = true;
    }

    builder = [
      this.binary
    ];

    Array.prototype.push.apply(builder,
      Object.keys(this.args).map(function(key) {
        return key + '=' + args[key];
      })
    );

    builder.push(this.scriptPath);

    if (base64EncodedUrl) {
      builder.push(
        '"' + base64encode(this.deferred.url) + '"',
        '--url-base64-encoded'
      );
    }
    else {
      builder.push(this.deferred.url);
    }

    if (this.notices) {
      builder.push('--notices');
    }
    if (this.warnings) {
      builder.push('--warnings');
    }

    return builder.join(' ');

    function base64encode(string) {
      return new Buffer(string || '').toString('base64');
    }
  },

  run: function() {
    var
      self = this,
      deferred = this.deferred,
      url = deferred.url,
      resultPromise,
      timeoutId;

    timeoutId = setTimeout(
      function() {
        resultPromise && resultPromise.cancel();
        deferred.reject('FAIL page "' + url + '" impress timeout ' + self.timeout);
        resultPromise.cancel();
      },
      this.timeout
    );

    invoke();

    function stopTimeout() {
      clearTimeout(timeoutId);
    }

    function finish(err, result) {
      stopTimeout();
      self._performImpressReport(result);
      result.content = new HtmlCompressor(result.content).getContent();
      deferred.finish(err, result);
    }

    function invoke() {
      var
        startTime = Date.now();
      resultPromise = self._invoke();
      resultPromise(function(err, result) {
        var
          invokeTime = Date.now() - startTime,
          _invoke;

        _invoke = function() {
          if (!resultPromise.canceled) {
            invoke();
          }
        };
        if (err || (err = self._validateContentAndGetValidationError(result.content))) {
          console.error('ERROR page "' + url + '" could not be impressed. Try next attempt.', err);
          if (invokeTime < MIN_INVOKE_INTERVAL) {
            setTimeout(_invoke, MIN_INVOKE_INTERVAL - invokeTime);
          }
          else {
            process.nextTick(_invoke);
          }
        }
        else {
          console.log('OK page "' + url + '" in time', Date.now() - startTime, 'ms');
          finish(err, result);
        }
      });
    }
  },

  _validateContentAndGetValidationError: function(content) {
    if (!/^\s*(<html|<!doctype)/i.test(content)) {
      return 'Could not found html tag or doctype info';
    }
    if (!/\/html\s*>\s*$/i.test(content)) {
      return 'Could not found close html tag';
    }
    return null;
  },

  _performImpressReport: function(result) {
    var
      url = this.deferred.url;

    if (this.warnings && result.warnings && result.warnings.length > 0) {
      console.warn('IMPRESS WARNINGS for page "' + (result.url || url) + '":\n', result.warnings.join('\n'));
    }
    if (this.notices && result.notices && result.notices.length > 0) {
      console.info('IMPRESS NOTICES for page "' + (result.url || url) + '":\n', result.notices.join('\n'));
    }
  },

  _invoke: function() {
    var
      self = this,
      child,
      stdout,
      stderr,
      errorDataBuffer = [],
      resultDataBuffer = [],
      resultListeners = [],
      resultPerformed = false,
      resultPromise;

    resultPromise = function(fn) {
      if (fn && typeof fn == 'function') {
        resultListeners.push(fn);
      }
    };
    resultPromise.canceled = false;
    resultPromise.cancel = function() {
      resultPromise.canceled = true;
      kill();
    };

    function kill() {
      try {
        child && child.kill();
      }
      catch(e) {
        console.error(e);
      }
    }

    function finish(error, result) {
      kill();
      if (resultPerformed || resultPromise.canceled) {
        return;
      }
      resultPerformed = true;
      resultListeners.forEach(function(fn) {
        try {
          fn && fn(error, result);
        }
        catch(e) {
          console.error(e);
        }
      });
    }

    function errorHandler(error) {
      finish(error || getErrorData() || 'Unknown Error');
    }

    function getErrorData() {
      return errorDataBuffer.join('');
    }

    function getResultData() {
      return resultDataBuffer.join('');
    }

    process.nextTick(function() {
      try {
        child = exec(self._getCommandExecString(), {
          timeout: self.execTimeout,
          maxBuffer: self.maxContentLength
        });
        child.on('error', errorHandler);
        child.on('close', function(code) {
          var
            error = getErrorData(),
            data = getResultData();

          if (code != OK_EXIT_CODE || error) {
            finish(error || data || 'Unknown Error');
            return;
          }

          try {
            data = JSON.parse(data);
          }
          catch(error) {
            finish(error);
            return;
          }

          if (!data.ok) {
            finish(data.errors || 'Unknown Error');
            return;
          }

          finish(null, data);
        });

        stdout = child.stdout;
        stdout.on('error', errorHandler);
        stdout.on('data', function(data) {
          resultDataBuffer.push(data);
        });

        stderr = child.stderr;
        stderr.on('error', errorHandler);
        stderr.on('data', function(data) {
          errorDataBuffer.push(data);
        });

      }
      catch(e) {
        errorHandler(e);
      }
    });

    return resultPromise;
  }



};