"use strict";

var fs = require('fs');
var path = require('path');
var child_process = require('child_process');
var async = require('async');

var RootfsExecuter = require('./rootfs_executer');

var Rootfs = module.exports = function() {
	var self = this;

	self.arch = null;
	self.targetPath = null;
	self.environmentReady = false;
};

Rootfs.prototype.clone = function(targetPath, callback) {
	var self = this;

	var rootfs = null;
	async.series([
		function(next) {

			fs.exists(self.targetPath, function(exists) {
				if (!exists) {
					next(new Error('No such rootfs.'));
					return;
				}

				next();
			});
		},
		function(next) {

			fs.exists(targetPath, function(exists) {
				if (!exists) {
					fs.mkdir(targetPath, function(err) {
						next(err);
					});
					return;
				}

				next();
			});
		},
		function(next) {

			fs.readdir(self.targetPath, function(err, files) {
				if (err) {
					next(err);
					return;
				}

				if (files.length == 0) {
					next(new Error('No such rootfs.'));
					return;
				}

				// Preparing entries
				var sources = [];
				for (var index in files) {
					sources.push(path.join(self.targetPath, files[index]));
				}

				// Arguments
				var args = [ '-a' ].concat(sources, [ targetPath ]);

				// Copying files
				var cmd = child_process.spawn('cp', args);
				cmd.on('close', function() {

					// Creatinga  new rootfs object
					rootfs = new Rootfs();
					rootfs.arch = self.arch;
					rootfs.targetPath = targetPath;

					next();
				});
			});
		}
	], function(err) {
		callback(err, rootfs);
	});
};

Rootfs.prototype.move = function(targetPath, callback) {
	var self = this;

	fs.exists(self.targetPath, function(exists) {
		if (!exists) {
			callback(new Error('No such rootfs.'));
			return;
		}

		fs.readdir(self.targetPath, function(err, files) {

			if (files.length == 0) {
				callback();
				return;
			}

			// Preparing entries
			var sources = [];
			for (var index in files) {
				sources.push(path.join(self.targetPath, files[index]));
			}

			// Arguments
			var args = [ '-f' ].concat(sources, [ targetPath ]);

			var cmd = child_process.spawn('mv', args);
			cmd.on('close', function() {
				self.targetPath = targetPath;
				callback();
			});
		});
	});
};

Rootfs.prototype.remove = function(callback) {
	var self = this;

	if (!self.targetPath) {
		process.nextTick(callback);
		return;
	}

	var cmd = child_process.spawn('rm', [
		'-fr',
		self.targetPath
	]);

	cmd.on('close', function() {
		callback();
	});
};

Rootfs.prototype.prepareEnvironment = function(callback) {
	var self = this;

	if (self.environmentReady) {
		process.nextTick(callback);
		return;
	}

	if (self.arch != 'armhf') {
		process.nextTick(callback);
		return;
	}

	async.series([

		function(next) {

			// Initializing domain name server settings
			var cmd = child_process.spawn('cp', [
				'-a',
				path.join('/', 'etc', 'resolv.conf'),
				path.join(self.targetPath, 'etc')
			]);

			cmd.on('close', function() {
				next();
			});
		},
		function(next) {

			// Preparing emulator
			var cmd = child_process.spawn('cp', [
				'-a',
				path.join('/', 'usr', 'bin', 'qemu-arm-static'),
				path.join(self.targetPath, 'usr', 'bin')
			]);

			cmd.on('close', function() {
				next();
			});
		},
		function(next) {

			// Initializing a fake environment to avoid invoke-rc.d running
			var fakeLinks = [
				'initctl',
				'invoke-rc.d',
				'restart',
				'start',
				'stop',
				'start-stop-daemon',
				'service'
			];

			var stemmerPath = path.join(self.targetPath, '.stemmer');
			fs.mkdir(stemmerPath, function(err) {
				if (err) {
					next(err);
					return;
				}

				async.each(fakeLinks, function(linkname, cb) {
					fs.symlink('/bin/true', path.join(stemmerPath, linkname), function(err) {
						cb(err);
					});
				}, function(err) {

					next();
				});

			});
			
		}
	], function() {
		self.environmentReady = true;
		callback();
	});
};

Rootfs.prototype.clearEnvironment = function(callback) {
	var self = this;

	if (!self.environmentReady) {
		process.nextTick(callback);
		return;
	}

	async.series([

		function(next) {

			var cmd = child_process.spawn('rm', [
				'-fr',
				path.join(self.targetPath, '.stemmer')
			]);

			cmd.on('close', function() {
				next();
			});
		},
		function(next) {

			fs.unlink(path.join(self.targetPath, 'usr', 'bin', 'qemu-arm-static'), next);
		},
		function(next) {

			fs.unlink(path.join(self.targetPath, 'etc', 'resolv.conf'), next);
		}
	], function() {
		self.environmentReady = false;
		callback();
	});
};

Rootfs.prototype.installPackages = function(packages, opts, callback) {
	var self = this;

	if (packages.length == 0) {
		process.nextTick(function() {
			callback(null);
		});
		return;
	}

	var pkgs = [];
	for (var name in packages) {
		var version = packages[name];
		if (version == '*' || version == '')
			pkgs.push(name);
		else
			pkgs.push(name + '=' + version);
	}

	var rootfsExecuter = new RootfsExecuter(self);

	rootfsExecuter.addCommand('apt-get update');
	rootfsExecuter.addCommand('apt-get install -f --no-install-recommends -q --force-yes -y ' + pkgs.join(' '))
	rootfsExecuter.addCommand('rm -fr /var/lib/apt/lists/*');
	rootfsExecuter.addCommand('apt-get clean');
	rootfsExecuter.run({}, function() {
		callback(null);
	});

};
