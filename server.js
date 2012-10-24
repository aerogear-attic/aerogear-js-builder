#!/bin/env node
//  OpenShift sample Node application
var _ = require( 'underscore' ),
    express = require( 'express' ),
    app = express.createServer(),
    async = require( 'async'),
    crypto = require( 'crypto' ),
    cssConcat = require( 'css-concat' ),
    fetch = require( './lib/project' ).fetch,
    fs = require( 'fs' ),
    mime = require( 'mime' ),
    path = require( 'path' ),
    promiseUtils = require( 'node-promise' ),
    Promise = require( 'node-promise').Promise,
    when = require( 'node-promise').when,
    regexp = require( './lib/regexp' ),
    requirejs = require( 'requirejs' ),
    semver = require( 'semver' ),
    url = require( 'url' ),
    zip = require("node-native-zip" );

var dataDir = process.env.OPENSHIFT_DATA_DIR || "/Users/lholmquist/develop/projects/";

//  Local cache for static content [fixed and loaded at startup]
var zcache = { 'index.html': '','builder.html':'', 'banner':"'<banner:meta.banner>'",'aerogearstart':"'<file_strip_banner:aerogear-js/", 'aerogearend':">'"};
zcache['index.html'] = fs.readFileSync('./index.html'); //  Cache index.html
zcache['builder.html'] = fs.readFileSync( "./builder.html" );

var dataDir = process.env.OPENSHIFT_DATA_DIR || "/Users/lholmquist/develop/projects/";

var Project = require( './lib/project' )
    .repoDir( "" )
    .stagingDir( dataDir + "aerogear-js-stage/" )
    .Project,
  filters = {},
  bundlePromises = {},
  dependenciesPromises = {};

app.use(express.bodyParser());

// Create "express" server.
var app  = express.createServer();


/*  =====================================================================  */
/*  Setup route handlers.  */
/*  =====================================================================  */

var bid = 0;
function buildDependencyMap( project, baseUrl, include ) {
    var id = bid++;
//    logger.log( "buildDependencyMap["+id+"]()" );
    var promise = new Promise(),
        shasum = crypto.createHash( 'sha1' ),
        compileDir = project.getCompiledDirSync(),
        filename = "",
        getFiles = function( dir, filterFn, mapFn, callback ) {
            // Recurse through directories in dir and collect a list of files that gets filtered by filterFn
            // The resulting list is processed by mapFn (remove extension for instance)
            fs.readdir( dir, function( err, dirEntries ) {
//                    console.log( "buildDependencyMap["+id+"](): step 1.1" );
                var filteredFiles, include;

                if ( err ) {
                    callback( err );
                } else {
                    async.waterfall([
                        function( next ) {
                            //Filter directories
                            async.filter( dirEntries,
                                function( dirEntry, callback ) {
                                    fs.stat( path.join( dir, dirEntry ), function( err, stats ) {
                                        if ( err ) {
                                            callback( false );
                                        } else {
                                            callback( stats.isDirectory() );
                                        }
                                    });
                                }, function( results ) {
                                    next( null, results );
                                }
                            );
                        },
                        function( dirs, next ) {
                            async.map( dirs,
                                function( dirName, callback ) {
                                    callback( null, path.join( dir, dirName ) );
                                }, next );
                        },
                        function( dirs, next ) {
                            async.concat( dirs,
                                function( subdir, cb ) {
                                    getFiles( subdir, filterFn, mapFn, cb );
                                }, next
                            );
                        },
                        function( modules, next ) {
                            async.filter( dirEntries,
                                function( item, callback ) {
                                    callback( filterFn( item ) );
                                },
                                function( filteredFiles ) {
                                    next( null, modules, filteredFiles );
                                }
                            );
                        },
                        function( modules, filteredFiles, next ) {
                            async.map( filteredFiles,
                                function( item, callback ) {
                                    callback( null, mapFn( path.join( dir, item ) ) );
                                },
                                function( err, results ) {
                                    next( err, modules.concat( results ) );
                                }
                            );
                        }
                    ], function( err, results ) {
                        callback( err, results );
                    });
                }
            });
        };

    async.waterfall([
    function( next ) {
      project.checkoutIfEmpty( next );
    },
        function( next ) {
            console.log( "buildDependencyMap["+id+"](): step 1" );
            // If no name is provided, scan the baseUrl for js files and return the dep map for all JS objects in baseUrl
            if ( include && include.length > 0 ) {
                next();
            } else {
                getFiles( baseUrl,
                    function( file ) {
                        return path.extname( file ) === ".js";
                    },
                    function( file ) {
                        var relPath = path.relative( baseUrl, file );
                        return relPath.substring( 0, relPath.length - ".js".length );
                    },
                    function( err, modules ) {
                        include = modules;
                        next( err );
                    }
                );
            }
        },
        function( next ) {
            console.log( "buildDependencyMap["+id+"](): step 2" );
            // Generate a sha on the sorted names
            var digest = shasum.update( include.join( "," ) ).digest( "hex" );

            filename += path.join(compileDir, "deps-" + digest + ".json" );
            console.log(filename);
            fs.readFile( filename, function( err, exists ) {
                next( null, digest, exists );
            });
        },
        function( digest, exists, next ) {
            console.log( "buildDependencyMap["+id+"](): step 3" );
            if ( exists ){
                fs.readFile( filename, "utf8", function( err, data ) {
                    if ( err ) {
                        next( err );
                    } else {
                        next( err, JSON.parse( data ) );
                    }
                });
            } else {
                if ( !dependenciesPromises[ digest ] ) {
                    dependenciesPromises[ digest ] = promise;
                    async.waterfall([
                        function( cb ) {
                           console.log( "buildDependencyMap["+id+"](): step 3.1" );
                            fs.mkdir( compileDir, function( err ) {
                                if ( err && err.code != "EEXIST" ) {
                                    cb( err );
                                } else {
                                    cb();
                                }
                            });
                        },
                        function( cb ) {
                           console.log( "buildDependencyMap["+id+"](): step 3.2" );
                            requirejs.tools.useLib( function ( r ) {
                                r( [ 'parse' ], function ( parse ) {
                                    cb( null, parse );
                                });
                            });
                        },
                        function( parse, cb ) {
                           console.log( "buildDependencyMap["+id+"](): step 3.3" );
                            var deps = {};
                            async.forEach( include, function ( name, done ) {
                                var fileName = path.join( baseUrl, name + ".js" ),
                                    dirName = path.dirname( fileName );
                                console.log( "Processing: " + fileName );
                                fs.readFile( fileName, 'utf8', function( err, data ) {
                                    if ( err ) {
                                        callback( err );
                                    }
                                    deps[ name ] = {};
                                    deps[ name ].deps = parse.findDependencies( fileName, data ).map(
                                        function( module ) {
                                            // resolve relative paths
                                            return path.relative( baseUrl, path.resolve( dirName, module ));
                                        }
                                    );
                                    done();
                                });
                            }, function( err ) {
                                cb( err, deps );
                            });
                        },
                        function( deps, cb ) {
                            console.log( "buildDependencyMap["+id+"](): step 3.4" );
                            // Walk through the dep map and remove baseUrl and js extension
                            var module,
                                modules = [],
                                baseUrlRE = new RegExp( "^" + regexp.escapeString( baseUrl + "/") ),
                                jsExtRE = new RegExp( regexp.escapeString( ".js" ) + "$" );
                            for ( module in deps ) {
                                modules.push( module );
                            }

                            async.forEach( modules,
                                function( item, callback ) {
                                    async.waterfall([
                                        function( next ) {
                                          console.log( "buildDependencyMap["+id+"](): step 3.4.1" );
                                          fs.readFile( path.join( baseUrl, item+".js" ), 'utf8', next );
                                        },
                                        function( data, next ) {
                                           console.log( "buildDependencyMap["+id+"](): step 3.4.2" );
                                            var lines = data.split( "\n" ),
                                                matches = lines.filter( function( line, index ) {
                                                    return /^.*\/\/>>\s*[^:]+:.*$/.test( line );
                                                });
                                            if ( matches && matches.length ) {
                                                matches.forEach( function( meta ) {
                                                    var attr = meta.replace( /^.*\/\/>>\s*([^:]+):.*$/, "$1" ).trim(),
                                                        attrLabelRE = new RegExp( "^.*" + regexp.escapeString( "//>>" + attr + ":") + "\\s*", "m" ),
                                                        value = meta.replace( attrLabelRE, "" ).trim(),
                                                        namespace, name,
                                                        indexOfDot = attr.indexOf( "." ),
                                                        dependsArray;
                                                    if( attr === "deps" ) {
                                                      value = value.split(",");
                                                    }
                                                    if ( indexOfDot > 0 ) { // if there is something before the dot
                                                        namespace = attr.split( "." )[0];
                                                        name = attr.substring( indexOfDot+1 );
                                                        deps[ item ][ namespace ] = deps[ item ][ namespace ] || {};
                                                        deps[ item ][ namespace ][ name ] = value;
                                                    } else {
                                                        deps[ item ][ attr ] = value;
                                                    }
                                                });
                                            }
                                            next();
                                        }
                                    ], callback );
                                },
                                function( err ) {
                                    if ( err ) {
                                        cb( err );
                                    } else {
                                        cb( null, deps );
                                    }
                                }
                            );
                        },
                        function( deps, cb ){
                            console.log( "buildDependencyMap["+id+"](): step 3.5" );
                            fs.writeFile( filename, JSON.stringify( deps ), "utf8",
                                function( err ) {
                                    cb( err, deps );
                                }
                            );
                        }
                    ], next );
                } else {
                    dependenciesPromises[ digest ].then(
                        function( data ) {
                            next( null, data );
                        },
                        next
                    );
                }
            }
        }
    ], function( err, data ) {
        if ( err ) {
            promise.reject( err );
        } else {
            promise.resolve( data );
        }
    });
    return promise;
}

function applyFilter( baseUrl, filter, contents, ext, callback ) {
    if ( filter ) {
        require( path.join( baseUrl, filter ) )( contents, ext, callback );
    } else {
        callback( null, contents );
    }
}

var bjsid = 0;
function buildJSBundle( project, config, name, filter, optimize ) {
    var id = bjsid ++;
//    console.log( "buildJSBundle["+id+"]()" );
    var promise = new Promise(),
        baseUrl = config.baseUrl,
        wsDir = project.getWorkspaceDirSync(),
        ext = ( optimize ? ".min" : "" ) + ".js",
        out = path.join( project.getCompiledDirSync(), name + ext );

    fs.exists( out, function ( exists ) {
        if ( exists ) {
            console.log( "buildJSBundle: resolving promise" );
            promise.resolve( out );
        } else {
            async.waterfall([
                function( next ) {
                    console.log( "buildJSBundle["+id+"](): step 1" );
                    var outDir = path.dirname( config.out );
                    console.log( "mkdir '" + outDir + "'" );
                    fs.mkdir( outDir, function( err ) {
                        console.log(err);
                        if ( err && err.code != "EEXIST" ) {
                            next( err );
                        } else {
                            next();
                        }
                    });
                },
                function( next ) {
                    console.log( "buildJSBundle["+id+"](): step 2" );
                    try {
                        requirejs.optimize(
                            _.extend({
                                out: out,
                                optimize: ( optimize ? "uglify" : "none" )
                            }, config ),
                            function( response ) {
                                next( null, response );
                            }
                        );
                    } catch ( e ){
                        next( e.toString() );
                    }
                },
                function( response, next ) {
                    console.log( "buildJSBundle["+id+"](): step 3" );
                    fs.readFile( out, 'utf8', next );
                },
                function ( contents, next ) {
                    console.log( "buildJSBundle["+id+"](): step 4" );
                    applyFilter( baseUrl, filter, contents, ext, next );
                },
                function( contents, next ) {
                    fs.writeFile( out, contents, 'utf8', next );
                }
            ], function( err ) {
                if( err ) {
                    promise.reject( err );
                } else {
//                    console.log( "buildJSBundle: resolving promise" );
                    promise.resolve( out );
                }
            });
        }
    });
    return promise;
}

function buildZipBundle( project, name, config, digest, filter )  {
    console.log( "buildZipBundle()" );
    var promise = new Promise(),
        baseUrl = config.baseUrl,
        basename = path.basename( name, ".zip" ),
        out = path.join( project.getCompiledDirSync(), digest + ".zip" );

    fs.exists( out, function ( exists ) {
        if ( exists ) {
            promise.resolve( out );
        } else {
            promiseUtils.all([
                buildJSBundle( project, config, digest, filter ),
                buildJSBundle( project, config, digest, filter, true )
            ]).then(
                function( results ) {
                    var archive = new zip();

                    async.series([
                        function( next ) {
                            async.forEachSeries( results, function( bundle, done ) {
                                var nameInArchive;
                                if ( typeof( bundle ) === "string" ) {
                                    nameInArchive = path.basename( bundle ).replace( digest, name.substring( 0, name.lastIndexOf( "." )) );
                                    archive.addFiles( [{ name: nameInArchive, path: bundle }], done );
                                } else {
                                    archive.addFiles(
                                        bundle.map( function( file ) {
                                            var nameInArchive = path.basename( file ).replace( digest, name.substring( 0, name.lastIndexOf( "." )) );
                                            return( { name: nameInArchive, path: file } );
                                        }), done
                                    );
                                }
                            }, next );
                        },
                        function( next ) {
                            fs.writeFile( out, archive.toBuffer(), next );
                        }
                    ], function( err ) {
                        if( err ) {
                            promise.reject( err );
                        } else {
                            promise.resolve( out );
                        }
                    });
                }
            );
        }
    });
    return promise;
}

app.get( '/v1/bundle/:owner/:repo/:ref/:name?', function ( req, res ) {
  console.log( "Building bundle for " + req.params.owner + "/" + req.params.repo + " ref: " + req.params.ref );
    var project = new Project( req.params.owner, req.params.repo, req.params.ref ),
        include = req.param( "include", "main" ).split( "," ).sort(),
        exclude = req.param( "exclude", "" ).split( "," ).sort(),
        optimize = Boolean( req.param( "optimize", false ) ).valueOf(),
        wrapParam = req.param( "wrap" ),
        wrap = wrapParam?JSON.parse( wrapParam ) : undefined,
        pragmas = JSON.parse( req.param( "pragmas", "{}" ) ),
        pragmasOnSave = JSON.parse( req.param( "pragmasOnSave", "{}" ) ),
        name = req.params.name || ( req.params.repo + ".js" ),
        ext = (optimize !== "none" ? ".min" : "") + ( path.extname( name ) || ".js" ),
        mimetype = mime.lookup( ext ),
        filter = req.param( "filter" ),
        shasum = crypto.createHash( 'sha1' ),
        wsDir   = project.getWorkspaceDirSync(),
        baseUrl = wsDir,
        dstDir, dstFile, digest, hash;

    // var baseUrlFilters[baseUrl] = require(path.join(baseUrl, 'somemagicnameOrpackage.jsonEntry.js'));
  var config = {
    baseUrl: baseUrl,
    include: include,
        exclude: exclude,
        wrap: wrap,
        pragmas: pragmas,
        pragmasOnSave: pragmasOnSave,
        skipModuleInsertion: req.param( "skipModuleInsertion", "false" ) === "true" ,
        preserveLicenseComments: req.param( "preserveLicenseComments", "true" ) === "true"
  };
    shasum.update( JSON.stringify( config ) );
    shasum.update( mimetype );
    if ( filter ) {
        shasum.update( filter );
    }

    if ( mimetype === "application/zip" ) {
        // For the zip file, the name needs to be part of the hash because it will determine the name of the files inside the zip file
        shasum.update( name );
    }

    digest = shasum.digest( 'hex' );

    if ( mimetype === "application/zip" ) {
        hash = digest;
    } else {
        hash += ( optimize ? ".min" : "" );
    }

    function onBundleBuildError( error ) {
        console.log(error);
        res.header( "Access-Control-Allow-Origin", "*");
        res.send( error, 500 );
        delete bundlePromises[ digest ];
    }

    function buildBundle() {
        var hash = digest;
        if ( mimetype === "application/zip" ) {
            bundlePromises[ hash ] = buildZipBundle( project, name, config, digest, filter );
        } else if ( mimetype === "text/css" ) {
            bundlePromises[ hash ] = buildCSSBundles( project, config, digest, filter, optimize );
        } else {
            bundlePromises[ hash ] = buildJSBundle( project, config, digest, filter, optimize );
        }
        bundlePromises[ hash ].then( onBundleBuilt, onBundleBuildError );
    }

    function onBundleBuilt( bundle ) {
        var out,
            promise = new Promise();

        // Set up our promise callbacks
        promise.then(
            function( bundleInfo ) {
                res.header( "Access-Control-Allow-Origin", "*");
                res.download( bundleInfo.path, bundleInfo.name );
            },
            function() {
                // Try to land back on our feet if for some reasons the built bundle got cleaned up;
                delete bundlePromises[ hash ];
                buildBundle();
            }
        );

        if ( typeof( bundle ) === "string" ) {
            fs.exists( bundle, function ( exists ) {
                if ( exists ) {
                    promise.resolve( { path: bundle, name: name } );
                } else {
                    promise.reject();
                }
            });
        } else {
            out = path.join( project.getCompiledDirSync(), digest + ext + ".zip" );
            fs.exists( out, function ( exists ) {
                var archive;
                if ( exists ) {
                    promise.resolve( { path: out, name: name } );
                } else {
                    archive = new zip();
                    async.series([
                        function( next ) {
                            archive.addFiles(
                                bundle.map( function( file ) {
                                    var nameInArchive = path.basename( file ).replace( digest, name.substring( 0, name.lastIndexOf( "." )) );
                                    return( { name: nameInArchive, path: file } );
                                }),
                                next
                            );
                        },
                        function( next ) {
                           fs.writeFile( out, archive.toBuffer(), next );
                        }
                    ],
                    function( err ) {
                        if( err ) {
                            promise.reject();
                        } else {
                            promise.resolve( { path: out, name: name + ".zip" } );
                        }
                    });
               }
            });
        }
    }

    if ( !bundlePromises[ hash ] ) {
        buildBundle();
    } else {
        bundlePromises[ hash ].then( onBundleBuilt, onBundleBuildError );
    }
});

app.get( '/aerogearjsbuilder/dependencies/:owner/:repo/:ref', function ( req, res ) {
    //console.log( dataDir );
    var project = new Project( req.params.owner, req.params.repo, req.params.ref ),
        names = req.param( "names", "" ).split( "," ).filter( function(name) {return !!name;} ).sort(),
        exclude = req.param( "exclude", "" ).split( "," ).sort(),
        baseUrl = path.normalize( path.join( project.getWorkspaceDirSync(), req.param( "baseUrl", "." ) ) );

    buildDependencyMap( project, baseUrl, names )
        .then( function( content ) {
            res.header( "Access-Control-Allow-Origin", "*");
            res.json( content );
        }, function( err ) {
            res.send( err, 500 );
        });
});

app.get( '/aerogearjsbuilder/bundle/:owner/:repo/:ref/:name?', function ( req, res ) {
    var project = new Project( req.params.owner, req.params.repo, req.params.ref ),
        include = req.param( "include", "main" ).split( "," ).sort(),
        exclude = req.param( "exclude", "" ).split( "," ).sort(),
        optimize = Boolean( req.param( "optimize", false ) ).valueOf(),
        name = req.params.name || ( req.params.repo + ".js" ),
        ext = (optimize !== "none" ? ".min" : "") + ( path.extname( name ) || ".js" ),
        mimetype = mime.lookup( ext ),
        shasum = crypto.createHash( 'sha1' ),
        wsDir   = project.getWorkspaceDirSync(),
        baseUrl = wsDir,
        dstDir, dstFile, digest, hash;

    // var baseUrlFilters[baseUrl] = require(path.join(baseUrl, 'somemagicnameOrpackage.jsonEntry.js'));
    var config = {
        baseUrl: baseUrl,
        include: include,
        exclude: exclude
    };
    shasum.update( JSON.stringify( config ) );
    shasum.update( mimetype );

    if ( mimetype === "application/zip" ) {
        // For the zip file, the name needs to be part of the hash because it will determine the name of the files inside the zip file
        shasum.update( name );
    }

    digest = shasum.digest( 'hex' );

    //if ( mimetype === "application/zip" ) {
        hash = digest;
    //} else {
    //    hash += ( optimize ? ".min" : "" );
   // }

    fs.readFile( "./data/aerogear-js-stage/lholmquist/master/gruntbase.js","utf-8", function( err, data){
        if( err ) {
            console.log( "gruntbase"+err );
        }
        //build replacement
        var replacement = "[" + zcache[ "banner" ] + ", ";
        _.each( config.include, function( val, index, list ) {
            replacement += zcache[ "aerogearstart" ] + val + ".js" + zcache[ "aerogearend" ];
            if( (index+1) !== list.length ) {
                replacement += ", ";
            }
        });

        replacement += "]";
        var temp = data.replace("\"@SRC@\"", replacement).replace("\"@DEST@\"", "'dist/<%= pkg.name %>." + hash + ".js'" );

        fs.writeFile('./data/aerogear-js-stage/lholmquist/master/' + hash + '.js',temp,'utf8',function( err ){
            if( err ) {
                console.log( "oh snap" + err);
                throw err;
            }

            var util  = require('util'),
            spawn = require('child_process').spawn,
            grunt = spawn( "grunt",["--config", hash + ".js"],{cwd:"./data/aerogear-js-stage/lholmquist/master/"} );

            grunt.stdout.on('data', function (data) {
                console.log('stdout: ' + data);
            });

            grunt.stderr.on('data', function (data) {
                console.log('stderr: ' + data);
            });

            grunt.on('exit', function (code) {
                res.send( fs.readFileSync("./data/aerogear-js-stage/lholmquist/master/dist/aerogear."+hash+".js" ) );
                console.log('child process exited with code ' + code);
                /*fs.unlink("./data/aerogear-js-stage/lholmquist/master/"+hash+".js", function( err ){
                    if ( err ) throw err;
                    console.log( 'file deleted' );
                });
                fs.unlink("./data/aerogear-js-stage/lholmquist/master/dist/aerogear."+hash+".js", function( err ){
                    if ( err ) throw err;
                    console.log( 'file deleted' );
                });*/
            });

        });

    });
});

// Handler for GET /
app.get('/', function(req, res){
    res.send( zcache[ "builder.html" ], { "Content-Type": "text/html" } );
});

app.get( "/css/*", function( req, res ) {
    res.send( fs.readFileSync("." + req.path ), { "Content-Type": "text/css" } );
});

app.get( "/js/*", function( req, res ) {
    res.send( fs.readFileSync("." + req.path ), { "Content-Type": "text/javascript" } );
});


//  Get the environment variables we need.
var ipaddr  = process.env.OPENSHIFT_INTERNAL_IP;
var port    = process.env.OPENSHIFT_INTERNAL_PORT || 8080;

if (typeof ipaddr === "undefined") {
   console.warn('No OPENSHIFT_INTERNAL_IP environment variable');
}

//  terminator === the termination handler.
function terminator(sig) {
   if (typeof sig === "string") {
      console.log('%s: Received %s - terminating Node server ...',
                  Date(Date.now()), sig);
      process.exit(1);
   }
   console.log('%s: Node server stopped.', Date(Date.now()) );
}

//  Process on exit and signals.
process.on('exit', function() { terminator(); });

// Removed 'SIGPIPE' from the list - bugz 852598.
['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGILL', 'SIGTRAP', 'SIGABRT', 'SIGBUS',
 'SIGFPE', 'SIGUSR1', 'SIGSEGV', 'SIGUSR2', 'SIGTERM'
].forEach(function(element, index, array) {
    process.on(element, function() { terminator(element); });
});

//  And start the app on that interface (and port).
app.listen(port, ipaddr, function() {
   console.log('%s: Node server started on %s:%d ...', Date(Date.now() ),
               ipaddr, port);
});

