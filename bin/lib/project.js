"use strict";

var fs = require('fs');
var path = require('path');
var child_process = require('child_process');
var async = require('async');
var Job = require('./job');
var Arch = require('./arch');
var Rootfs = require('./rootfs');
var Recipe = require('./recipe');

var Project = module.exports = function() {
	var self = this;

	self.basePath = path.join(__dirname, '..', '..', 'projects');
	self.recipePath = path.join(__dirname, '..', '..', 'recipes');
	self.projectName = null;
	self.settings = {};
	self.arch = 'i386';
	self.platform = null;
	self.refPlatform = null;
};

Project.prototype.load = function(projectName, callback) {
	var self = this;

	if (!projectName) {
		process.nextTick(function() {
			callback(new Error('Require project name.'));
		});
		return;
	}

	self.projectName = projectName;
	var configPath = path.join(self.basePath, projectName, 'project.json');

	fs.readFile(configPath, function(err, data) {
		if (err) {
			callback(err);
			return;
		}

		self.settings = JSON.parse(data);

		// This architecture depends on another one
		if (self.settings.platform) {

			// Initializing such platform
			var platform = new Arch();
			platform.platform = self.settings.platform;
			platform.init(function(err, platform) {
				if (err) {
					callback(new Error('Cannot found such platform ' + self.settings.platform));
					return;
				}

				// Getting architecture
				self.refPlatform = platform;
				self.arch = platform.arch;

				callback(null);
			});

			return;
		}

		callback(new Error('Require platform'));
	});
};

Project.prototype.buildExists = function(callback) {
	var self = this;

	fs.exists(path.join(__dirname, '..', '..', 'build', self.projectName), function(exists) {
		callback(exists);
	});
};

Project.prototype.getRootfs = function(opts, callback) {
	var self = this;

	var buildPath = path.join(__dirname, '..', '..', 'build', self.projectName, 'rootfs');

	self.buildExists(function(exists) {

		// Trying to rebuild this rootfs
		if (exists) {

			// Creating rootfs object
			var rootfs = new Rootfs();
			rootfs.arch = self.arch;
			rootfs.targetPath = buildPath;

			callback(null, rootfs);

			return;
		}

		if (opts.makeIfDoesNotExists) {
			// Build rootfs
			self.build(callback);
		} else {
			callback(null, null);
		}
	});
};

Project.prototype.build = function(opts, callback) {
	var self = this;

	var job = null;
	var curRootfs = null;
	var buildPath = path.join(__dirname, '..', '..', 'build', self.projectName, 'rootfs');
	var packages = {};
	var recipes = {};
	async.series([
		function(next) {

			// Create a job
			job = new Job();
			job.create(function() {
				next();
			});
		},
		function(next) {

			var targetPath = path.join(job.jobPath, 'rootfs');

			// This architecture depends on another one
			if (self.refPlatform) {

				// Based on referenced platform
				self.refPlatform.getRootfs({ makeIfDoesNotExists: true }, function(err, refRootfs) {

					// Clone
					refRootfs.clone(targetPath, function(err, rootfs) {
						if (err) {
							next(err);
							return;
						}

						curRootfs = rootfs;
						next();
					});
				});
				return;
			}
		},
		function(next) {

			if (!self.settings.hostname) {
				next();
				return;
			}


			// Write to hostname configuration file
			fs.writeFile(path.join(curRootfs.targetPath, 'etc', 'hostname'), self.settings.hostname, function() {
				next();
			});
		},
		function(next) {

			curRootfs.prepareEnvironment(next);
		},
		function(next) {

			if (!self.settings.recipes) {
				next();
				return;
			}

			// Apply recipes
			var targetPkgDir = path.join(curRootfs.initialDirPath, 'packages');
			async.eachSeries(Object.keys(self.settings.recipes), function(recipeName, cb) {

				var recipe = new Recipe(recipeName);
				recipe.init({}, function(err) {
					if (err) {
						cb();
						return;
					}

					recipes[recipeName] = recipe;

					// Getting all caches
					var pkgNames = Object.keys(recipe.packageCaches);
					if (pkgNames.length == 0) {
						cb();
						return;
					}
					
					async.eachSeries(pkgNames, function(name, _cb) {

						var cacheFilename = recipe.packageCaches[name];

						// Copying to target rootfs
						var cmd = child_process.spawn('cp', [
							'-a',
							cacheFilename,
							targetPkgDir
						]);

						cmd.on('close', function() {

							_cb();
						});
					}, function() {

						cb();
					});

				});

			}, function(err) {

				if (err) {
					curRootfs.clearEnvironment(function() {
						next(err);
					});

					return;
				}

				next(err);
			});

		},
		function(next) {

			// Apply packages in initial directory
			curRootfs.applyPackages({}, function(err) {
				next(err);
			});

		},
		function(next) {

			if (self.settings.packages) {
				for (var name in self.settings.packages) {
					packages[name] = self.settings.packages[name];
				}
			}

			if (Object.keys(packages).length == 0) {
				next();
				return;
			}

			// Install packages in config file
			curRootfs.installPackages(packages, {}, function() {

				// Create caches
				async.eachSeries(recipes, function(recipe, cb) {

					recipe.cache({}, function(err) {
						cb();
					});
					
				}, function() {
					next();
				});
			});
		},
		function(next) {

			curRootfs.clearEnvironment(next);
		},
		function(next) {

			// Remove old rootfs if it exists
			self.getRootfs({}, function(err, rootfs) {

				if (rootfs) {

					// Remove
					rootfs.remove(function() {

						next();
					});

					return;
				}

				next();
			});
		},
		function(next) {

			// Create a new directory for rootfs
			var cmd = child_process.spawn('mkdir', [
				'-p',
				buildPath
			]);

			cmd.on('close', function() {

				// Moving rootfs to another place for storing
				curRootfs.move(buildPath, next);
			});

		}
	], function(err) {

		job.release(function() {
			callback(err, curRootfs || null);
		});
	});
};
