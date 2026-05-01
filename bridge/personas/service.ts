import type { AppStateRepository } from '@bridge/app-state/repository';
import type {
  CreatePersonaInput,
  PersonaDefinition,
  UpdatePersonaInput
} from '@bridge/ipc/contracts';
import type { PersonaRepository } from './repository';

export class PersonaService {
  constructor(
    private readonly repository: PersonaRepository,
    private readonly appState: AppStateRepository
  ) {}

  list(): PersonaDefinition[] {
    return this.repository.list();
  }

  create(input: CreatePersonaInput): PersonaDefinition {
    return this.repository.createUserPersona(input);
  }

  update(input: UpdatePersonaInput): PersonaDefinition {
    return this.repository.updateUserPersona(input);
  }

  delete(personaId: string): void {
    this.repository.deleteUserPersona(personaId);

    const activeId = this.getActivePersonaId();
    if (activeId === personaId) {
      this.setActivePersona(null);
    }
  }

  getActivePersona(): PersonaDefinition | null {
    const activeId = this.getActivePersonaId();
    if (!activeId) {
      return null;
    }
    return this.repository.getById(activeId);
  }

  setActivePersona(personaId: string | null): void {
    this.appState.setJson('activePersonaId', personaId);
  }

  private getActivePersonaId(): string | null {
    return this.appState.getJson<string | null>('activePersonaId') ?? null;
  }
}
