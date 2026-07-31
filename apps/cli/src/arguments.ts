import type { ServiceCredentialScope } from '@unkeep/client';
import type { ConfigFlags } from './config.js';

export type CommandName = 'login' | 'provision' | 'credentials' | 'list' | 'get' | 'put' | 'delete' | 'sync' | 'clip' | 'paste';

export interface ParsedArguments extends ConfigFlags {
  command?: CommandName;
  configDir?: string;
  json: boolean;
  help: boolean;
  version: boolean;
  name?: string;
  scope?: ServiceCredentialScope;
  labels: string[];
  archived?: boolean;
  pinned?: boolean;
  search?: string;
  id?: string;
  title?: string;
  content?: string;
  listClips: boolean;
  force: boolean;
  positionals: string[];
}

const commands = new Set<CommandName>(['login', 'provision', 'credentials', 'list', 'get', 'put', 'delete', 'sync', 'clip', 'paste']);

function booleanValue(option: string, value: string | undefined): boolean {
  if (value === undefined || value === '') return true;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error(`${option} expects true or false`);
}

function serviceCredentialScope(option: string, value: string): ServiceCredentialScope {
  if (value === 'read-only' || value === 'read-write') return value;
  throw new Error(`${option} expects read-only or read-write`);
}

export function parseArguments(arguments_: readonly string[]): ParsedArguments {
  const result: ParsedArguments = {
    json: false,
    help: false,
    version: false,
    listClips: false,
    force: false,
    labels: [],
    positionals: [],
  };

  let positionalOnly = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (positionalOnly) {
      result.positionals.push(argument);
      continue;
    }
    if (argument === '--') {
      positionalOnly = true;
      continue;
    }
    if (!argument.startsWith('-')) {
      if (!result.command && commands.has(argument as CommandName)) result.command = argument as CommandName;
      else result.positionals.push(argument);
      continue;
    }

    const equals = argument.indexOf('=');
    const option = equals === -1 ? argument : argument.slice(0, equals);
    const inlineValue = equals === -1 ? undefined : argument.slice(equals + 1);
    const takeValue = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      const value = arguments_[index + 1];
      if (value === undefined) throw new Error(`${option} requires a value`);
      index += 1;
      return value;
    };

    switch (option) {
      case '--endpoint': result.endpoint = takeValue(); break;
      case '--credential': result.credential = takeValue(); break;
      case '--vault-key': result.vaultKey = takeValue(); break;
      case '--config-dir': result.configDir = takeValue(); break;
      case '--name': result.name = takeValue(); break;
      case '--scope': result.scope = serviceCredentialScope(option, takeValue()); break;
      case '--label': result.labels.push(takeValue()); break;
      case '--search':
      case '-q': result.search = takeValue(); break;
      case '--id': result.id = takeValue(); break;
      case '--title': result.title = takeValue(); break;
      case '--content': result.content = takeValue(); break;
      case '--list': result.listClips = booleanValue(option, inlineValue); break;
      case '--force': result.force = booleanValue(option, inlineValue); break;
      case '--archived': result.archived = booleanValue(option, inlineValue); break;
      case '--no-archived': result.archived = false; break;
      case '--pinned': result.pinned = booleanValue(option, inlineValue); break;
      case '--no-pinned': result.pinned = false; break;
      case '--json': result.json = booleanValue(option, inlineValue); break;
      case '--help':
      case '-h': result.help = true; break;
      case '--version': result.version = true; break;
      default: throw new Error(`Unknown option: ${option}`);
    }
  }
  return result;
}
