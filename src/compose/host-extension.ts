import * as _ from 'lodash';
import type { ContainerInfo } from 'dockerode';

import * as docker from '../lib/docker-utils';
import App from './app';
import Service from './service';
import type { CompositionStep } from './composition-steps';
import * as images from './images';
import type { Image } from './images';

class HostExtensionContainer {
	serviceName: string;
	appId: number;
	appUuid: string;
	image: string;
	dockerImageId: string;

	private constructor() {}

	public static fromDockerContainer(
		container: ContainerInfo,
	): HostExtensionContainer {
		const ext = new HostExtensionContainer();
		ext.serviceName = container.Labels['io.balena.service-name'];
		ext.appId = parseInt(container.Labels['io.balena.app-id'], 10);
		ext.appUuid = container.Labels['io.balena.app-uuid'];
		ext.image = container.Image;
		ext.dockerImageId = container.ImageID;
		return ext;
	}

	public static fromService(service: Service): HostExtensionContainer {
		const ext = new HostExtensionContainer();
		return ext;
	}
}

export async function getRequiredSteps(
	targetState: Dictionary<App>,
	availableImages: Image[],
	downloading: number[],
): Promise<CompositionStep[]> {
	// First thing to do is to work out if we must download any images
	const toFetch = extensionImagesToFetch(targetState, availableImages);
	if (toFetch.length > 0) {
		return toFetch.map((svc) => ({
			action: 'fetch',
			image: images.imageFromService(svc),
		}));
	}

	// If we get here, we have all extension images available

	// In the future we want the supervisor to do these extension installations
	// itself (e.g. tear down old containers, create new ones, reboot) but for
	// now, we send the list of images to a helper script on the OS which handles
	// it for us

	return [];
}

// export async function install(image: Image) {}

// export async function remove(image: Image) {}

async function getCurrent(): Promise<HostExtensionContainer[]> {
	// Find all installed host extensions
	const extensions = (
		await docker.docker.listContainers({
			filters: { label: ['io.balena.features.host-extension'] },
		})
	).map(HostExtensionContainer.fromDockerContainer);

	return extensions;
}

async function targetExtFromTargetState(
	targetState: Dictionary<App>,
): Promise<HostExtensionContainer[]> {
	return [];
}

function extensionImagesToFetch(
	targetState: Dictionary<App>,
	availableImages: Image[],
): Service[] {
	return _.flatMap(targetState, (app) =>
		app.services.filter(
			(svc) =>
				!_.some(
					availableImages,
					(image) =>
						image.dockerImageId === svc.config.image ||
						images.isSameImage(image, { name: svc.imageName! }),
				),
		),
	);
}

// needsDownload = !_.some(
// 	context.availableImages,
// 	(image) =>
// 		image.dockerImageId === target?.config.image ||
// 		imageManager.isSameImage(image, { name: target?.imageName! }),
// );
