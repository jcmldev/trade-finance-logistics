/**
 * Copyright 2016 IBM All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the 'License');
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an 'AS IS' BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 */
'use strict';

var cproc = require('child_process');
var utils = require('fabric-client/lib/utils.js');
var logger = utils.getLogger('E2E update-channel');

var tape = require('tape');
var _test = require('tape-promise');
var test = _test(tape);

var Client = require('fabric-client');
var util = require('util');
var fs = require('fs');
var path = require('path');
var grpc = require('grpc');

var _commonProto = grpc.load(path.join(__dirname, 'node_modules/fabric-client/lib/protos/common/common.proto')).common;
var _configtxProto = grpc.load(path.join(__dirname, 'node_modules/fabric-client/lib/protos/common/configtx.proto')).common;
var protobufjs = require('protobufjs');
var configProto = protobufjs.loadProtoFile(path.join(__dirname, 'node_modules/fabric-client/lib/protos/common/configtx.proto')).build('common.Config');
var configEnvelopeProto = protobufjs.loadProtoFile(path.join(__dirname, 'node_modules/fabric-client/lib/protos/common/configtx.proto')).build('common.ConfigEnvelope');

var Constants = require('./constants.js');
var ClientUtils = require('./clientUtils.js');
var sdkHelper = require('./sdkHelper.js');

var ORGS, PEER_ORGS;

// Enroll 'admin' user of an org
function enrollOrgAdminAndSignConfig(org, client, config, signatures) {
	client._userContext = null;

	return ClientUtils.getSubmitter(client, true /*get the org admin*/, org)
	.then((admin) => {
		console.log('Successfully enrolled user \'admin\' for', org);

		// sign the config
		var signature = client.signChannelConfig(config);
		console.log('Successfully signed config update as admin of', org);

		// collect signature from org admin
		signatures.push(signature);
	})
}

//
//Attempt to send a request to the orderer with the updateChannel method
//
function upgradeChannel(channel_name) {
	Client.addConfigFile(path.join(__dirname, Constants.networkConfig));
	ORGS = Client.getConfigSetting(Constants.networkId);
	PEER_ORGS = [];
	Object.keys(ORGS).forEach((org) => {
		if(org !== 'orderer') {
			PEER_ORGS.push(org);
		}
	})

	var client = new Client();

	// Read the TLS certificates to establish a secure connection to the orderer
	var caRootsPath = ORGS.orderer.tls_cacerts;
	let data = fs.readFileSync(path.join(__dirname, caRootsPath));
	let caroots = Buffer.from(data).toString();

	var orderer = client.newOrderer(
		ORGS.orderer.url,
		{
			'pem': caroots,
			'ssl-target-name-override': ORGS.orderer['server-hostname']
		}
	);

	var config = null;		// Network channel configuration
	var signatures = [];		// Collect signatures to submit to orderer for channel updation

	// Attempt to update the channel as a client of Constants.IMPORTER_ORG
	var org = ORGS[Constants.IMPORTER_ORG].name;

	// Use a file-based key-value store for this network instance
	utils.setConfigSetting('key-value-store', 'fabric-client/lib/impl/FileKeyValueStore.js');

	return Client.newDefaultKeyValueStore({		// Set the key-value store location
		path: ClientUtils.storePathForOrg(org)
	}).then((store) => {
		client.setStateStore(store);		// Set application state location on the file sysytem
		var cryptoSuite = Client.newCryptoSuite();
		cryptoSuite.setCryptoKeyStore(Client.newCryptoKeyStore({path: ClientUtils.storePathForOrg(org)}));
		client.setCryptoSuite(cryptoSuite);	// Set storage location for cryptographic material
		
		client._userContext = null;
		return ClientUtils.getOrderAdminSubmitter(client);
	}).then((admin) => {
		console.log('Successfully enrolled user \'admin\' for orderer');

		var channel = client.newChannel(channel_name);
		channel.addOrderer(
			client.newOrderer(
				ORGS.orderer.url,
				{
					'pem': caroots,
					'ssl-target-name-override': ORGS.orderer['server-hostname']
				}
			)
		);
		return channel.getChannelConfigFromOrderer();
	}).then((configuration_block) => {
		console.log('Got configuration block');
		console.log('Current config version:', configuration_block.config.sequence.toString());

		// Create temporary folder for configuration files
		if(!fs.existsSync('./tmp/')) {
			fs.mkdirSync('./tmp');
		}

		// Write current channel configuration to file for 'configtxlator' to read
		fs.writeFileSync('./tmp/config.pb', configuration_block.config.toBuffer());

		// Decode the current channel configuration into JSON format
		cproc.execSync('configtxlator proto_decode --input ./tmp/config.pb --type common.Config | jq . > ./tmp/config.json');

		// Append new organization configuration to current configuration
		cproc.execSync('jq -s \'.[0] * {"channel_group":{"groups":{"Application":{"groups": {"ExportingEntityOrgMSP":.[1]}}}}}\' ./tmp/config.json ../network/channel-artifacts/exportingEntityOrg.json > ./tmp/modified_config.json');

		// Encode the new configuration into protobuf
		cproc.execSync('configtxlator proto_encode --input ./tmp/modified_config.json --type common.Config --output ./tmp/modified_config.pb');

		// Compute the delta (difference) between current channel config and the new config we have created
		cproc.execSync('configtxlator compute_update --channel_id ' + channel_name + ' --original ./tmp/config.pb --updated ./tmp/modified_config.pb --output ./tmp/exportingEntityOrg_update.pb');

		config = fs.readFileSync('./tmp/exportingEntityOrg_update.pb');
		console.log('Successfully created the config update');

		var enrollmentAndSignPromises = [];
		PEER_ORGS.forEach((org) => {
			enrollmentAndSignPromises.push(enrollOrgAdminAndSignConfig);
		})
		// Enroll 'admin' user for each org and get their signatures on the channel config update in sequence
		return enrollmentAndSignPromises.reduce(
			(promiseChain, currentFunction, currentIndex) =>
				promiseChain.then(() => {
					return currentFunction(PEER_ORGS[currentIndex], client, config, signatures);
				}), Promise.resolve()
		);
	}).then(() => {
		console.log('Successfully enrolled user \'admin\' for every org and collected config update signatures');
		console.log('Update configuration now has', signatures.length, ' signatures');

		// build up the update request
		let tx_id = client.newTransactionID();
		var request = {
			config: config,
			//envelope: config,
			signatures : signatures,
			name : channel_name,
			orderer : orderer,
			txId  : tx_id
		};

		// send update request to orderer
		return client.updateChannel(request);
	})
	.then((result) => {
		logger.debug('Channel configuration updated; response ::%j',result);
		console.log('Successfully updated the channel.');
		if(result.status && result.status === 'SUCCESS') {
			return sdkHelper.sleep(5000);
		} else {
			throw new Error('Failed to update the channel. ');
		}
	}, (err) => {
		throw new Error('Failed to update the channel: ' + err.stack ? err.stack : err);
	})
	.then((nothing) => {
		console.log('Successfully waited to make sure new channel was updated.');
	}, (err) => {
		throw new Error('Failed to sleep; error: ' + err.stack ? err.stack : err);
	});
}

upgradeChannel(Constants.CHANNEL_NAME).then(() => {
	console.log('\n');
	console.log('--------------------------');
	console.log('CHANNEL UPGRADE COMPLETE');
	console.log('--------------------------');
	console.log('\n');
}, (err) => {
	console.log('\n');
	console.log('-------------------------');
	console.log('CHANNEL UPGRADE FAILED:', err);
	console.log('-------------------------');
	console.log('\n');
	process.exit(1);
});
