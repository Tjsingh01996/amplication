import { Inject, Injectable } from "@nestjs/common";
import { isEmpty } from "lodash";
import { PrismaService, Prisma, EnumResourceType } from "../../prisma";
import { FindOneArgs } from "../../dto";
import { AmplicationError } from "../../errors/AmplicationError";
import { Resource } from "../../models/Resource";
import { GitOrganization } from "../../models/GitOrganization";
import { CreateGitOrganizationArgs } from "./dto/args/CreateGitOrganizationArgs";
import { DeleteGitOrganizationArgs } from "./dto/args/DeleteGitOrganizationArgs";
import { DeleteGitRepositoryArgs } from "./dto/args/DeleteGitRepositoryArgs";
import { GetGitInstallationUrlArgs } from "./dto/args/GetGitInstallationUrlArgs";
import { GitOrganizationFindManyArgs } from "./dto/args/GitOrganizationFindManyArgs";
import { ConnectGitRepositoryInput } from "./dto/inputs/ConnectGitRepositoryInput";
import { CreateGitRepositoryInput } from "./dto/inputs/CreateGitRepositoryInput";
import { RemoteGitRepositoriesWhereUniqueInput } from "./dto/inputs/RemoteGitRepositoriesWhereUniqueInput";
import { RemoteGitRepos } from "./dto/objects/RemoteGitRepository";
import { GitClientService } from "@amplication/git-utils";
import {
  INVALID_RESOURCE_ID,
  ResourceService,
} from "../resource/resource.service";
import { CompleteGitOAuth2FlowArgs } from "./dto/args/CompleteGitOAuth2FlowArgs";
import { EnumGitOrganizationType } from "./dto/enums/EnumGitOrganizationType";
import { AmplicationLogger } from "@amplication/util/nestjs/logging";
import { ConfigService } from "@nestjs/config";
import { Env } from "../../env";
import { GitGroupArgs } from "./dto/args/GitGroupArgs";
import { PaginatedGitGroup } from "./dto/objects/PaginatedGitGroup";

const GIT_REPOSITORY_EXIST =
  "Git Repository already connected to an other Resource";
const INVALID_GIT_REPOSITORY_ID = "Git Repository does not exist";

@Injectable()
export class GitProviderService {
  private clientId: string;
  private clientSecret: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly resourceService: ResourceService,
    private readonly configService: ConfigService,
    @Inject(AmplicationLogger)
    private readonly logger: AmplicationLogger
  ) {
    this.clientId = this.configService.get<string>(Env.BITBUCKET_CLIENT_ID);
    this.clientSecret = this.configService.get<string>(
      Env.BITBUCKET_CLIENT_SECRET
    );
  }

  async getReposOfOrganization(
    args: RemoteGitRepositoriesWhereUniqueInput
  ): Promise<RemoteGitRepos> {
    const installationId = await this.getInstallationIdByGitOrganizationId(
      args.gitOrganizationId
    );

    const gitOrganization = await this.getGitOrganization({
      where: { id: args.gitOrganizationId },
    });

    const lowerCaseProvider = args.gitProvider.toLowerCase();

    const gitProviderArgs = {
      provider: args.gitProvider,
      installationId,
      clientId: this.clientId || null,
      clientSecret: this.clientSecret || null,
    };

    const gitClientService = await new GitClientService().create(
      gitProviderArgs,
      this.logger
    );

    const oauth2args = gitOrganization.useGroupingForRepositories
      ? {
          accessToken:
            gitOrganization.providerProperties[lowerCaseProvider][
              "accessToken"
            ],
          refreshToken:
            gitOrganization.providerProperties[lowerCaseProvider][
              "refreshToken"
            ],
        }
      : null;

    const repositoriesArgs = {
      limit: args.limit,
      page: args.page,
      oauth2args,
      gitGroupName: args.gitGroupName,
    };
    return gitClientService.getRepositories(repositoriesArgs);
  }

  async createRemoteGitRepository(
    args: CreateGitRepositoryInput
  ): Promise<Resource> {
    const organization = await this.getGitOrganization({
      where: {
        id: args.gitOrganizationId,
      },
    });
    const repository = {
      repositoryName: args.name,
      gitOrganization: {
        name: organization.name,
        type: EnumGitOrganizationType[organization.type],
        useGroupingForRepositories: false,
      },
      owner: organization.name,
      isPrivateRepository: args.public,
    };
    const gitProviderArgs = {
      installationId: organization.installationId,
      provider: args.gitProvider,
    };
    const gitClientService = await new GitClientService().create(
      gitProviderArgs,
      this.logger
    );
    const remoteRepository = await gitClientService.createRepository(
      repository
    );

    if (!remoteRepository) {
      throw new AmplicationError(
        `Failed to create ${args.gitProvider} repository ${organization.name}\\${args.name}`
      );
    }

    return await this.connectResourceGitRepository({
      name: remoteRepository.name,
      gitOrganizationId: args.gitOrganizationId,
      resourceId: args.resourceId,
    });
  }

  async deleteGitRepository(args: DeleteGitRepositoryArgs): Promise<boolean> {
    const gitRepository = await this.prisma.gitRepository.findUnique({
      where: {
        id: args.gitRepositoryId,
      },
    });

    if (isEmpty(gitRepository)) {
      throw new AmplicationError(INVALID_GIT_REPOSITORY_ID);
    }

    await this.prisma.gitRepository.delete({
      where: {
        id: args.gitRepositoryId,
      },
    });

    return true;
  }

  async disconnectResourceGitRepository(resourceId: string): Promise<Resource> {
    const resource = await this.prisma.resource.findUnique({
      where: {
        id: resourceId,
      },
      include: {
        gitRepository: true,
      },
    });

    if (isEmpty(resource)) throw new AmplicationError(INVALID_RESOURCE_ID);

    const resourcesToDisconnect = await this.getInheritProjectResources(
      resource.projectId,
      resourceId,
      resource.resourceType
    );

    await this.prisma.gitRepository.update({
      where: {
        id: resource.gitRepositoryId,
      },
      data: {
        resources: {
          disconnect: resourcesToDisconnect,
        },
      },
    });

    const countResourcesConnected = await this.prisma.gitRepository
      .findUnique({
        where: {
          id: resource.gitRepositoryId,
        },
      })
      .resources();

    if (countResourcesConnected.length === 0) {
      await this.prisma.gitRepository.delete({
        where: {
          id: resource.gitRepositoryId,
        },
      });
    }

    return resource;
  }

  async connectResourceToProjectRepository(
    resourceId: string
  ): Promise<Resource> {
    const resource = await this.prisma.resource.findUnique({
      where: {
        id: resourceId,
      },
    });

    if (isEmpty(resource)) throw new AmplicationError(INVALID_RESOURCE_ID);

    if (resource.gitRepositoryId) {
      await this.disconnectResourceGitRepository(resourceId);
    }

    const projectConfigurationRepository = await this.prisma.resource
      .findFirst({
        where: {
          projectId: resource.projectId,
          resourceType: EnumResourceType.ProjectConfiguration,
        },
      })
      .gitRepository();

    if (isEmpty(projectConfigurationRepository)) {
      return resource;
    }
    const resourceWithProjectRepository = await this.prisma.resource.update({
      where: {
        id: resourceId,
      },
      data: {
        gitRepository: {
          connect: {
            id: projectConfigurationRepository.id,
          },
        },
      },
    });
    return resourceWithProjectRepository;
  }

  async connectResourceGitRepository({
    resourceId,
    name,
    gitOrganizationId,
  }: ConnectGitRepositoryInput): Promise<Resource> {
    const gitRepository = await this.prisma.gitRepository.findFirst({
      where: { resources: { some: { id: resourceId } } },
    });

    if (gitRepository) {
      throw new AmplicationError(GIT_REPOSITORY_EXIST);
    }

    const resource = await this.resourceService.resource({
      where: {
        id: resourceId,
      },
    });

    const resourcesToConnect = await this.getInheritProjectResources(
      resource.projectId,
      resourceId,
      resource.resourceType
    );

    await this.prisma.gitRepository.create({
      data: {
        name: name,
        resources: { connect: resourcesToConnect },
        gitOrganization: { connect: { id: gitOrganizationId } },
      },
    });

    return await this.prisma.resource.findUnique({
      where: {
        id: resourceId,
      },
    });
  }

  // part of sync with GitHub flow (ONLY!)
  async createGitOrganization(
    args: CreateGitOrganizationArgs
  ): Promise<GitOrganization> {
    const { gitProvider, installationId } = args.data;
    const gitClientService = await new GitClientService().create(
      {
        provider: gitProvider,
        installationId,
      },
      this.logger
    );

    const gitRemoteOrganization = await gitClientService.getOrganization();

    const gitOrganization = await this.prisma.gitOrganization.findFirst({
      where: {
        installationId: installationId,
        provider: gitProvider,
      },
    });

    if (gitOrganization) {
      return await this.prisma.gitOrganization.update({
        where: {
          id: gitOrganization.id,
        },
        data: {
          provider: gitProvider,
          installationId: installationId,
          name: gitRemoteOrganization.name,
          type: gitRemoteOrganization.type,
          providerProperties: {
            github: {
              installationId,
            },
          },
        },
      });
    }

    return await this.prisma.gitOrganization.create({
      data: {
        workspace: {
          connect: {
            id: args.data.workspaceId,
          },
        },
        installationId,
        name: gitRemoteOrganization.name,
        provider: gitProvider,
        type: gitRemoteOrganization.type,
        useGroupingForRepositories: false,
        providerProperties: {
          github: {
            installationId,
          },
        },
      },
    });
  }

  async getGitOrganizations(
    args: GitOrganizationFindManyArgs
  ): Promise<GitOrganization[]> {
    return await this.prisma.gitOrganization.findMany(args);
  }

  async getGitOrganization(args: FindOneArgs): Promise<GitOrganization> {
    return await this.prisma.gitOrganization.findUnique(args);
  }
  async getGitOrganizationByRepository(
    args: FindOneArgs
  ): Promise<GitOrganization> {
    return await this.prisma.gitRepository.findUnique(args).gitOrganization();
  }

  async getGitInstallationUrl(
    args: GetGitInstallationUrlArgs
  ): Promise<string> {
    const { gitProvider, workspaceId } = args.data;
    const gitClientService = await new GitClientService().create(
      {
        provider: gitProvider,
        installationId: null,
        clientId: this.clientId,
        clientSecret: this.clientSecret,
      },
      this.logger
    );
    return await gitClientService.getGitInstallationUrl(workspaceId);
  }

  async getCurrentOAuthUser(oAuthUserName: string): Promise<GitOrganization> {
    return this.prisma.gitOrganization.findFirst({
      where: { name: oAuthUserName },
    });
  }

  async completeOAuth2Flow(
    args: CompleteGitOAuth2FlowArgs
  ): Promise<GitOrganization> {
    const { code, gitProvider, workspaceId } = args.data;
    const gitClientService = await new GitClientService().create(
      {
        provider: gitProvider,
        installationId: null,
        clientId: this.clientId,
        clientSecret: this.clientSecret,
      },
      this.logger
    );
    try {
      const {
        accessToken,
        refreshToken,
        expiresIn,
        tokenType,
        scopes,
        userData: { username, uuid },
      } = await gitClientService.completeOAuth2Flow(code);

      return this.prisma.gitOrganization.upsert({
        where: {
          // eslint-disable-next-line @typescript-eslint/naming-convention
          provider_installationId: {
            provider: gitProvider,
            installationId: uuid,
          },
        },
        create: {
          provider: gitProvider,
          installationId: uuid,
          name: username,
          type: EnumGitOrganizationType.User,
          useGroupingForRepositories: true,
          workspace: {
            connect: {
              id: workspaceId,
            },
          },
          providerProperties: {
            bitbucket: {
              username,
              uuid,
              accessToken,
              refreshToken,
              expiresIn,
              tokenType,
              scopes,
            },
          },
        },
        update: {
          name: username,
          providerProperties: {
            bitbucket: {
              username,
              uuid,
              accessToken,
              refreshToken,
              expiresIn,
              tokenType,
              scopes,
            },
          },
        },
      });
    } catch (error) {
      this.logger.error(error);
    }
  }

  async getGitGroups(args: GitGroupArgs): Promise<PaginatedGitGroup> {
    const { gitProvider, oAuthUserName } = args.where;
    const lowerCaseProvider = gitProvider.toLowerCase();
    const gitClientService = await new GitClientService().create(
      {
        provider: gitProvider,
        installationId: null,
        clientId: this.clientId,
        clientSecret: this.clientSecret,
      },
      this.logger
    );
    const currentUser = await this.getCurrentOAuthUser(oAuthUserName);
    return await gitClientService.getGitGroups({
      accessToken:
        currentUser.providerProperties[lowerCaseProvider]["accessToken"],
      refreshToken:
        currentUser.providerProperties[lowerCaseProvider]["refreshToken"],
    });
  }

  async deleteGitOrganization(
    args: DeleteGitOrganizationArgs
  ): Promise<boolean> {
    const { gitProvider, gitOrganizationId } = args;

    const installationId = await this.getInstallationIdByGitOrganizationId(
      gitOrganizationId
    );
    const gitClientService = await new GitClientService().create(
      {
        provider: gitProvider,
        installationId,
      },
      this.logger
    );
    if (installationId) {
      const isDelete = await gitClientService.deleteGitOrganization();
      if (isDelete) {
        await this.prisma.gitOrganization.delete({
          where: {
            id: gitOrganizationId,
          },
        });
      } else {
        throw new AmplicationError(
          `delete installationId: ${installationId} failed`
        );
      }
    }
    return true;
  }

  private async getInstallationIdByGitOrganizationId(
    gitOrganizationId: string
  ): Promise<string | null> {
    return (
      await this.prisma.gitOrganization.findUnique({
        where: {
          id: gitOrganizationId,
        },
      })
    ).installationId;
  }

  private async getInheritProjectResources(
    projectId: string,
    resourceId: string,
    resourceType: EnumResourceType
  ): Promise<Prisma.ResourceWhereUniqueInput[]> {
    let resourcesToConnect: Prisma.ResourceWhereUniqueInput[];

    if (resourceType === EnumResourceType.ProjectConfiguration) {
      const resources = await this.prisma.resource.findMany({
        where: {
          // eslint-disable-next-line @typescript-eslint/naming-convention
          OR: [
            {
              projectId: projectId,
              gitRepositoryOverride: false,
            },
            {
              id: resourceId,
            },
          ],
        },
      });

      resourcesToConnect = resources.map((r) => ({ id: r.id }));
    } else {
      resourcesToConnect = [
        {
          id: resourceId,
        },
      ];
    }
    return resourcesToConnect;
  }
}
