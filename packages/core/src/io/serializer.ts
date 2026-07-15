/**
 * Versioned project serialization.
 *
 * A `.opencut` file is JSON: `{ schemaVersion, project }`. On load we run any migrations
 * from the file's version up to the current one, so old projects keep opening as the model
 * evolves. This is the contract that lets us change the schema without breaking users.
 */

import { SCHEMA_VERSION, type Project } from '../model/types.js';

export interface ProjectFile {
  schemaVersion: number;
  project: Project;
}

/** Migration functions keyed by the version they upgrade FROM. Add as the schema grows. */
const migrations: Record<number, (p: Project) => Project> = {
  // 1: (p) => ({ ...p, /* v1 -> v2 changes */ schemaVersion: 2 }),
};

export function serializeProject(project: Project): string {
  const file: ProjectFile = {
    schemaVersion: SCHEMA_VERSION,
    project: { ...project, modifiedAt: Date.now() },
  };
  return JSON.stringify(file, null, 2);
}

export function deserializeProject(json: string): Project {
  const parsed = JSON.parse(json) as Partial<ProjectFile> & Partial<Project>;

  // Tolerate both wrapped ({schemaVersion, project}) and bare-project files.
  let project: Project;
  let version: number;
  if (parsed && typeof parsed === 'object' && 'project' in parsed && parsed.project) {
    project = parsed.project as Project;
    version = (parsed as ProjectFile).schemaVersion ?? project.schemaVersion ?? 1;
  } else {
    project = parsed as Project;
    version = project.schemaVersion ?? 1;
  }

  let current = project;
  while (version < SCHEMA_VERSION) {
    const migrate = migrations[version];
    if (!migrate) {
      throw new Error(`No migration from schema version ${version}`);
    }
    current = migrate(current);
    version++;
  }
  return { ...current, schemaVersion: SCHEMA_VERSION };
}
