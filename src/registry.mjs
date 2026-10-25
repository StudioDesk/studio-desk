import { WorkflowRegistry, AdapterRegistry, OrganizationPresetRegistry } from './core/registry.mjs';
import { ConnectorRegistry } from './core/connectors.mjs';
import { FormatRegistry } from './core/formats.mjs';
import { gameOrganizationPreset } from './organizations/game-studio/index.mjs';
import { firstRunOrganizationPreset } from './organizations/first-run/index.mjs';
import { localRecordsConnector } from './connectors/local-records.mjs';
import { localOperationAdapter } from './adapters/local-operation.mjs';
import { gameCompositionFixture, architectureCompositionFixture } from './packs/composition-fixtures/index.mjs';
import { gameProductionPack } from './packs/game-production/index.mjs';
import { simulatorAdapter } from './adapters/simulator.mjs';
import { codexAdapter } from './adapters/codex.mjs';
import { claudeAdapter } from './adapters/claude.mjs';
import { unrealGatewayFixtureAdapter } from './adapters/unreal-gateway-fixture.mjs';
import { sourceChecksAdapter } from './adapters/source-checks.mjs';
import { sourceChangeAdapter } from './adapters/source-change.mjs';
import { sourceBreakdownAdapter } from './adapters/source-breakdown.mjs';
import { studioDevelopmentPack } from './packs/studio-development/index.mjs';
import { generalWorkPack } from './packs/general-work/index.mjs';

export function createRegistries() {
  const connectors = new ConnectorRegistry().register(localRecordsConnector),
    formats = new FormatRegistry();
  return {
    organizations: new OrganizationPresetRegistry()
      .register(gameOrganizationPreset)
      .register(firstRunOrganizationPreset),
    connectors,
    formats,
    workflows: new WorkflowRegistry(connectors, formats)
      .register(gameProductionPack)
      .register(gameCompositionFixture)
      .register(architectureCompositionFixture)
      .register(studioDevelopmentPack)
      .register(generalWorkPack),
    adapters: new AdapterRegistry()
      .register(simulatorAdapter)
      .register(codexAdapter)
      .register(claudeAdapter)
      .register(unrealGatewayFixtureAdapter)
      .register(localOperationAdapter)
      .register(sourceChecksAdapter)
      .register(sourceChangeAdapter)
      .register(sourceBreakdownAdapter),
  };
}

export const defaultRegistries = createRegistries();
