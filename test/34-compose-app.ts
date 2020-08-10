import * as _ from 'lodash';
import { expect } from 'chai';

import * as appMock from './lib/application-state-mock';

import * as applicationManager from '../src/compose/application-manager';
import App from '../src/compose/app';
import * as config from '../src/config';
import * as dbFormat from '../src/device-state/db-format';

import Service from '../src/compose/service';
import Network from '../src/compose/network';
import Volume from '../src/compose/volume';
import {
	CompositionStep,
	CompositionStepAction,
} from '../src/compose/composition-steps';
import { ServiceComposeConfig } from '../src/compose/types/service';
import { registerOverride } from './lib/mocked-dockerode';
import { Image } from '../src/compose/images';
import { inspect } from 'util';
import { boolean } from 'yargs';
import { Test } from 'mocha';
import { Z_BEST_COMPRESSION } from 'mz/zlib';

const defaultContext = {
	localMode: false,
	availableImages: [],
	containerIds: {},
	downloading: [],
};

function createApp(
	services: Service[],
	networks: Network[],
	volumes: Volume[],
	target: boolean,
	appId = 1,
) {
	return new App(
		{
			appId,
			services,
			networks: _.keyBy(networks, 'name'),
			volumes: _.keyBy(volumes, 'name'),
		},
		target,
	);
}

function createService(
	conf: Partial<ServiceComposeConfig>,
	appId = 1,
	serviceName = 'test',
	releaseId = 2,
	serviceId = 3,
	imageId = 4,
	extraState?: Partial<Service>
) {
	const svc = Service.fromComposeObject(
		{
			appId,
			serviceName,
			releaseId,
			serviceId,
			imageId,
			...conf,
		},
		{} as any,
	);
	if (extraState != null) {
		for (const k of Object.keys(extraState)) {
			(svc as any)[k] = (extraState as any)[k];
		}
	}
	return svc;
}

type ServicePredicate = string | ((service: Partial<Service>) => boolean);
type StepTest = Chai.Assertion & {
	forCurrent: (predicate: ServicePredicate) => Chai.Assertion,
	forTarget: (predicate: ServicePredicate) => Chai.Assertion,
}

// tslint:disable: no-unused-expression-chai
function withSteps(steps: CompositionStep[]) {
	return {
		expectStep: (step: CompositionStepAction): StepTest => {
			const matchingSteps = _.filter(steps, s => s.action === step);

			const assertion: Partial<StepTest> = expect(matchingSteps, `Step for '${step}', not found`);

			const forService = (predicate: ServicePredicate, property: 'current' | 'target') => {
				const [firstMatch] = _.filter(steps, (s) => {
					if (s.action !== step) {
						return false;
					}

					const t = (s as any)[property];
					if (!t) {
						throw new Error(`${property} is not defined for action ${step}`);
					}

					if (_.isFunction(predicate)) {
						return predicate(t);
					} else {
						return t.serviceName! === predicate
					}
				});
				return expect(firstMatch, `Step for '${step}' matching predicate, not found`);
			}

			assertion.forCurrent = (service) => forService(service, 'current');
			assertion.forTarget = (service) => forService(service, 'target');

			return assertion as StepTest;
		}
	}
}

function expectStep(
	action: CompositionStepAction,
	steps: CompositionStep[],
): number {
	const idx = _.findIndex(steps, { action });
	if (idx === -1) {
		console.log(inspect({ action, steps }, true, 3, true));
		throw new Error(`Expected to find step with action: ${action}`);
	}
	return idx;
}

function expectNoStep(
	action: CompositionStepAction,
	steps: CompositionStep[],
) {
	if (_.some(steps, { action })) {
		console.log(inspect({ action, steps }, true, 3, true));
		throw new Error(`Did not expect to find step with action: ${action}`);
	}
}

const defaultNetwork = Network.fromComposeObject('default', 1, {});

describe.only('compose/app', () => {
	before(async () => {
		await config.initialized;
		await applicationManager.initialized;
	});
	beforeEach(() => {
		// Sane defaults
		appMock.mockSupervisorNetwork(true);
		appMock.mockManagers([], [], []);
		appMock.mockImages([], false, []);
	});
	afterEach(() => {
		appMock.unmockAll();
	});

	it.skip('should correctly migrate legacy applications');

	it('should correctly infer a volume create step', () => {
		const current = createApp([], [], [], false);
		const target = createApp(
			[],
			[],
			[Volume.fromComposeObject('test-volume', 1, {})],
			true,
		);

		const steps = current.nextStepsForAppUpdate(defaultContext, target);

		const idx = expectStep('createVolume', steps);
		expect(steps[idx])
			.to.have.property('target')
			.that.has.property('name')
			.that.equals('test-volume');
	});

	it('should correctly infer more than one volume create step', () => {
		const current = createApp([], [], [], false);
		const target = createApp(
			[],
			[],
			[
				Volume.fromComposeObject('test-volume', 1, {}),
				Volume.fromComposeObject('test-volume-2', 1, {}),
			],
			true,
		);

		const steps = current.nextStepsForAppUpdate(defaultContext, target);
		let idx = expectStep('createVolume', steps);
		expect(steps[idx])
			.to.have.property('target')
			.that.has.property('name')
			.that.equals('test-volume');
		delete steps[idx];
		idx = expectStep('createVolume', steps);
		expect(steps[idx])
			.to.have.property('target')
			.that.has.property('name')
			.that.equals('test-volume-2');
	});

	// We don't remove volumes until the end
	it('should correctly not infer a volume remove step when the app is still referenced', () => {
		const current = createApp(
			[],
			[],
			[
				Volume.fromComposeObject('test-volume', 1, {}),
				Volume.fromComposeObject('test-volume-2', 1, {}),
			],
			false,
		);
		const target = createApp(
			[],
			[],
			[Volume.fromComposeObject('test-volume-2', 1, {})],
			true,
		);

		const steps = current.nextStepsForAppUpdate(defaultContext, target);

		expect(() => {
			expectStep('removeVolume', steps);
		}).to.throw();
	});

	it('should correctly infer volume recreation steps', () => {
		const current = createApp(
			[],
			[],
			[Volume.fromComposeObject('test-volume', 1, {})],
			false,
		);
		const target = createApp(
			[],
			[],
			[
				Volume.fromComposeObject('test-volume', 1, {
					labels: { test: 'test' },
				}),
			],
			true,
		);

		let steps = current.nextStepsForAppUpdate(defaultContext, target);

		let idx = expectStep('removeVolume', steps);
		expect(steps[idx])
			.to.have.property('current')
			.that.has.property('config')
			.that.has.property('labels')
			.that.deep.equals({ 'io.balena.supervised': 'true' });

		current.volumes = {};
		steps = current.nextStepsForAppUpdate(defaultContext, target);
		idx = expectStep('createVolume', steps);
		expect(steps[idx])
			.to.have.property('target')
			.that.has.property('config')
			.that.has.property('labels')
			.that.deep.equals({ 'io.balena.supervised': 'true', test: 'test' });
	});

	it('should kill dependencies of a volume before changing config', () => {
		const current = createApp(
			[createService({ volumes: ['test-volume'] })],
			[],
			[Volume.fromComposeObject('test-volume', 1, {})],
			false,
		);
		const target = createApp(
			[createService({ volumes: ['test-volume'] })],
			[],
			[
				Volume.fromComposeObject('test-volume', 1, {
					labels: { test: 'test' },
				}),
			],
			true,
		);

		const steps = current.nextStepsForAppUpdate(defaultContext, target);

		const idx = expectStep('kill', steps);
		expect(steps[idx])
			.to.have.property('current')
			.that.has.property('serviceName')
			.that.equals('test');
	});

	it('should correctly infer to remove an apps volumes when it is no longer referenced', async () => {
		appMock.mockManagers(
			[],
			[Volume.fromComposeObject('test-volume', 1, {})],
			[],
		);
		appMock.mockImages([], false, []);

		const origFn = dbFormat.getApps;
		// @ts-expect-error Assigning to a RO property
		dbFormat.getApps = () => Promise.resolve({});

		try {
			const steps = await applicationManager.getRequiredSteps();
			expect(steps).to.have.length(1);
			expect(steps[0]).to.have.property('action').that.equals('removeVolume');
		} finally {
			// @ts-expect-error Assigning to a RO property
			dbFormat.getApps = origFn;
		}
	});

	it('should correctly infer a network create step', () => {
		const current = createApp([], [], [], false);
		const target = createApp(
			[],
			[Network.fromComposeObject('default', 1, {})],
			[],
			true,
		);

		const steps = current.nextStepsForAppUpdate(defaultContext, target);
		expectStep('createNetwork', steps);
	});

	it('should correctly infer a network remove step', () => {
		const current = createApp(
			[],
			[Network.fromComposeObject('test-network', 1, {})],
			[],
			false,
		);
		const target = createApp([], [], [], true);

		const steps = current.nextStepsForAppUpdate(defaultContext, target);
		const idx = expectStep('removeNetwork', steps);
		expect(steps[idx])
			.to.have.property('current')
			.that.has.property('name')
			.that.equals('test-network');
	});

	it('should correctly infer a network recreation step', () => {
		const current = createApp(
			[],
			[Network.fromComposeObject('test-network', 1, {})],
			[],
			false,
		);
		const target = createApp(
			[],
			[
				Network.fromComposeObject('test-network', 1, {
					labels: { TEST: 'TEST' },
				}),
			],
			[],
			true,
		);

		let steps = current.nextStepsForAppUpdate(defaultContext, target);
		let idx = expectStep('removeNetwork', steps);
		expect(steps[idx])
			.to.have.property('current')
			.that.has.property('name')
			.that.equals('test-network');

		delete current.networks['test-network'];
		steps = current.nextStepsForAppUpdate(defaultContext, target);
		idx = expectStep('createNetwork', steps);
		expect(steps[idx])
			.to.have.property('target')
			.that.has.property('name')
			.that.equals('test-network');
	});

	it('should kill dependencies of networks before removing', () => {
		const current = createApp(
			[createService({ networks: { 'test-network': {} } })],
			[Network.fromComposeObject('test-network', 1, {})],
			[],
			false,
		);
		const target = createApp([createService({})], [], [], true);

		const steps = current.nextStepsForAppUpdate(defaultContext, target);
		const idx = expectStep('kill', steps);
		expect(steps[idx])
			.to.have.property('current')
			.that.has.property('serviceName')
			.that.equals('test');
	});

	it('should kill dependencies of networks before changing config', () => {
		const current = createApp(
			[createService({ networks: { 'test-network': {} } })],
			[Network.fromComposeObject('test-network', 1, {})],
			[],
			false,
		);
		const target = createApp(
			[createService({ networks: { 'test-network': {} } })],
			[
				Network.fromComposeObject('test-network', 1, {
					labels: { test: 'test' },
				}),
			],
			[],
			true,
		);

		const steps = current.nextStepsForAppUpdate(defaultContext, target);
		const idx = expectStep('kill', steps);
		expect(steps[idx])
			.to.have.property('current')
			.that.has.property('serviceName')
			.that.equals('test');
		// We shouldn't try to remove the network until we have gotten rid of the dependencies
		expect(() => expectStep('removeNetwork', steps)).to.throw();
	});

	it('should not output a kill step for a service which is already stopping when changing a volume', () => {
		const service = createService({ volumes: ['test-volume'] });
		service.status = 'Stopping';
		const current = createApp(
			[service],
			[],
			[Volume.fromComposeObject('test-volume', 1, {})],
			false,
		);
		const target = createApp(
			[service],
			[],
			[
				Volume.fromComposeObject('test-volume', 1, {
					labels: { test: 'test' },
				}),
			],
			true,
		);

		const steps = current.nextStepsForAppUpdate(defaultContext, target);
		expect(() => expectStep('kill', steps)).to.throw();
	});

	it('should create the default network if it does not exist', () => {
		const current = createApp([], [], [], false);
		const target = createApp([], [], [], true);

		const steps = current.nextStepsForAppUpdate(defaultContext, target);
		const idx = expectStep('createNetwork', steps);
		expect(steps[idx])
			.to.have.property('target')
			.that.has.property('name')
			.that.equals('default');
	});

	it('should create a kill step for service which is no longer referenced', async () => {
		const current = createApp(
			[createService({}, 1, 'main', 1, 1), createService({}, 1, 'aux', 1, 2)],
			[Network.fromComposeObject('test-network', 1, {})],
			[],
			false
		);
		const target = createApp(
			[createService({}, 1, 'main', 2, 1)],
			[Network.fromComposeObject('test-network', 1, {})],
			[],
			true
		);

		const steps = current.nextStepsForAppUpdate(defaultContext, target);
		const idx = expectStep('kill', steps);
		expect(steps[idx])
			.to.have.property('current')
			.that.has.property('serviceName')
			.that.equals('aux');
	});

	it('should emit a noop when a service which is no longer referenced is already stopping', async () => {
		const current = createApp(
			[createService({}, 1, 'main', 1, 1, 1, { status: 'Stopping' })],
			[],
			[],
			false
		);
		const target = createApp(
			[],
			[],
			[],
			true
		);

		const steps = current.nextStepsForAppUpdate(defaultContext, target);
		expectStep('noop', steps);
	});

	it('should remove a dead container that is still referenced in the target state', () => {
		const current = createApp(
			[createService({}, 1, 'main', 1, 1, 1, { status: 'Dead' })],
			[],
			[],
			false
		);
		const target = createApp(
			[createService({}, 1, 'main', 1, 1, 1)],
			[],
			[],
			true
		);

		const steps = current.nextStepsForAppUpdate(defaultContext, target);
		expectStep('remove', steps);
	});

	it('should remove a dead container that is not referenced in the target state', () => {
		const current = createApp(
			[createService({}, 1, 'main', 1, 1, 1, { status: 'Dead' })],
			[],
			[],
			false
		);
		const target = createApp(
			[],
			[],
			[],
			true
		);

		const steps = current.nextStepsForAppUpdate(defaultContext, target);
		expectStep('remove', steps);
	});

	it('should emit a noop when a service has an image downloading', () => {
		const current = createApp(
			[],
			[],
			[],
			false
		);
		const target = createApp(
			[createService({}, 1, 'main', 1, 1, 1)],
			[],
			[],
			true
		);

		const steps = current.nextStepsForAppUpdate({...defaultContext, ...{ downloading: [1] }}, target);
		expectStep('noop', steps);
	});

	it('should emit an updateMetadata step when a service has not changed but the release has', () => {
		const current = createApp(
			[createService({}, 1, 'main', 1, 1, 1)],
			[],
			[],
			false
		);
		const target = createApp(
			[createService({}, 1, 'main', 2, 1, 1)],
			[],
			[],
			true
		);

		const steps = current.nextStepsForAppUpdate(defaultContext, target);
		expectStep('updateMetadata', steps);
	});

	it.skip('should start a container which has not been started', () => {
		const current = createApp(
			[createService({}, 1, 'main', 1, 1, 1, { status: 'Installed'})],
			[],
			[],
			false
		);
		const target = createApp(
			[createService({}, 1, 'main', 1, 1, 1)],
			[],
			[],
			true
		);

		const steps = current.nextStepsForAppUpdate(defaultContext, target);
		expectStep('start', steps);
	});

	it('should stop a container which has stoppped as its target', () => {
		const current = createApp(
			[createService({}, 1, 'main', 1, 1, 1)],
			[],
			[],
			false
		);
		const target = createApp(
			[createService({ running: false }, 1, 'main', 1, 1, 1)],
			[],
			[],
			true
		);

		const steps = current.nextStepsForAppUpdate(defaultContext, target);
		expectStep('stop', steps);
	});

	it('should recreate a container if the target configuration changes', () => {
		const contextWithImages = {
			...defaultContext,
			... {
				availableImages: [
					{
						appId: 1,
						dependent: 0,
						imageId: 1,
						releaseId: 1,
						serviceId: 1,
						name: 'main-image',
						serviceName: 'main'
					}
				]
			}
		}
		let current = createApp(
			[createService({}, 1, 'main', 1, 1, 1, {})],
			[defaultNetwork],
			[],
			false
		);
		const target = createApp(
			[createService({ privileged: true }, 1, 'main', 1, 1, 1, {})],
			[defaultNetwork],
			[],
			true
		);

		// should see a 'stop'
		let steps = current.nextStepsForAppUpdate(contextWithImages, target);
		withSteps(steps).expectStep('stop').to.exist;

		// remove the service since it's stopped...
		current = createApp([], [defaultNetwork], [], false);

		// now should see a 'start'
		steps = current.nextStepsForAppUpdate(contextWithImages, target);
		withSteps(steps).expectStep('start').forTarget(t => t.serviceName === 'main').to.exist;
	});

	it('should not start a container when it depends on a service which is being installed', () => {
		const mainImage: Image = {
			appId: 1,
			dependent: 0,
			imageId: 1,
			releaseId: 1,
			serviceId: 1,
			name: 'main-image',
			serviceName: 'main'
		};

		const depImage: Image = {
			appId: 1,
			dependent: 0,
			imageId: 2,
			releaseId: 1,
			serviceId: 2,
			name: 'dep-image',
			serviceName: 'dep'
		};

		const availableImages = [mainImage, depImage];
		const contextWithImages = { ...defaultContext, ...{ availableImages } };

		try {
			let current = createApp(
				[createService({ running: false }, 1, 'dep', 1, 2, 2, { status: 'Installing', containerId: 'id' })],
				[defaultNetwork],
				[],
				false
			);
			const target = createApp(
				[createService({}, 1, 'main', 1, 1, 1, { dependsOn: ['dep'] }), createService({}, 1, 'dep', 1, 2, 2)],
				[defaultNetwork],
				[],
				true
			);

			let steps = current.nextStepsForAppUpdate(contextWithImages, target);
			withSteps(steps)
				.expectStep('start')
				.forTarget(t => t.serviceName === 'dep')
				.to.exist;

			withSteps(steps)
				.expectStep('start')
				.forTarget(t => t.serviceName === 'main')
				.to.not.exist;

			// we now make our current state have the 'dep' service as started...
			current = createApp(
				[createService({}, 1, 'dep', 1, 2, 2, { containerId: 'id' })],
				[defaultNetwork],
				[],
				false
			);

			// We keep track of the containers that we've tried to start so that we
			// dont spam start requests if the container hasn't started running
			applicationManager.containerStarted['id'] = true;

			// we should now see a start for the 'main' service...
			steps = current.nextStepsForAppUpdate({ ...contextWithImages, ...{ containerIds: { 'dep': 'id' } } }, target);
			withSteps(steps)
				.expectStep('start')
				.forTarget(t => t.serviceName === 'main')
				.to.exist;

		} finally {
			delete applicationManager.containerStarted['id'];
		}
	});

	it('should emit a fetch step when an image has not been downloaded for a service', () => {
		const current = createApp(
			[],
			[],
			[],
			false
		);
		const target = createApp(
			[createService({}, 1, 'main', 1, 1, 1)],
			[],
			[],
			true
		);

		const steps = current.nextStepsForAppUpdate(defaultContext, target);
		withSteps(steps).expectStep('fetch').to.exist;
	});

	it('should stop a container which has stoppped as its target', () => {
		const current = createApp(
			[createService({}, 1, 'main', 1, 1, 1)],
			[],
			[],
			false
		);
		const target = createApp(
			[createService({ running: false }, 1, 'main', 1, 1, 1)],
			[],
			[],
			true
		);

		const steps = current.nextStepsForAppUpdate(defaultContext, target);
		withSteps(steps).expectStep('stop');
	});

	it('should create a start step when all that changes is a running state', () => {
		const contextWithImages = {
			...defaultContext,
			... {
				availableImages: [
					{
						appId: 1,
						dependent: 0,
						imageId: 1,
						releaseId: 1,
						serviceId: 1,
						name: 'main-image',
						serviceName: 'main'
					}
				]
			}
		}
		const current = createApp(
			[createService({ running: false }, 1, 'main', 1, 1, 1, {})],
			[defaultNetwork],
			[],
			false
		);
		const target = createApp(
			[createService({}, 1, 'main', 1, 1, 1, {})],
			[defaultNetwork],
			[],
			true
		);

		// now should see a 'start'
		const steps = current.nextStepsForAppUpdate(contextWithImages, target);
		withSteps(steps).expectStep('start').forTarget(t => t.serviceName === 'main').to.exist;
	});

	it('should not infer a fetch step when the download is already in progress', () => {
		const contextWithDownloading = {
			...defaultContext,
			... {
				downloading: [1]
			}
		}
		const current = createApp(
			[],
			[],
			[],
			false
		);
		const target = createApp(
			[createService({}, 1, 'main', 1, 1, 1)],
			[],
			[],
			true
		);

		const steps = current.nextStepsForAppUpdate(contextWithDownloading, target);
		withSteps(steps)
			.expectStep('fetch')
			.forTarget('main')
			.to.not.exist;
	});

	it('should create a kill step when a service has to be updated but the strategy is kill-then-download', () => {
		const contextWithImages = {
			...defaultContext,
			... {
				availableImages: [
					{
						appId: 1,
						dependent: 0,
						imageId: 1,
						releaseId: 1,
						serviceId: 1,
						name: 'main-image',
						serviceName: 'main'
					}
				]
			}
		}

		const labels = {
			'io.balena.update.strategy': 'kill-then-download'
		}

		const current = createApp(
			[createService({ labels, image: 'main-image' }, 1, 'main', 1, 1, 1, {})],
			[defaultNetwork],
			[],
			false
		);
		const target = createApp(
			[createService({labels, image: 'main-image-2' }, 1, 'main', 2, 1, 2, {})],
			[defaultNetwork],
			[],
			true
		);

		let steps = current.nextStepsForAppUpdate(contextWithImages, target);
		console.log({steps});
		withSteps(steps)
			.expectStep('kill')
			.forCurrent('main')
			.to.exist;

		// next volatile state...
		const afterKill = createApp(
			[],
			[defaultNetwork],
			[],
			false
		);

		// TODO: here we would expect a kill, before the download... not happening and needs looking at...
		steps = afterKill.nextStepsForAppUpdate(contextWithImages, target);
		console.log({steps});
		const idx = expectStep('fetch', steps);
		expect(steps[idx]).to.have.property('image').that.has.property('name').that.equals('main-image-2');
		withSteps(steps)
			.expectStep('fetch')
			.to.exist;
	});
	it.skip(
		'should not infer a kill step with the default strategy if a dependency is not downloaded',
	);
	it.skip(
		'should create several kill steps as long as there is no unmet dependencies',
	);
	it.skip('should start a dependency container first');
	it.skip(
		'should create a kill step when a service has to be updated but the strategy is kill-then-download',
	);
	it.skip(
		'should not infer a kill step with the default strategy if a dependency is not downloaded',
	);
	it.skip(
		'should create several kill steps as long as there is no unmet dependencies',
	);
	it.skip('should start a dependency container first');
	it.skip('infers to start a service once its dependencies have been met');
	it.skip('should remove spurious containers');
	it.skip('should not create a service when its dependencies have not been met'); // no create service, is create network
});