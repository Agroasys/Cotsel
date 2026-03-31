import { EventFragment, id as keccakId } from 'ethers';
import { contractInterface } from './abi';

export const ESCROW_EVENT_SIGNATURES = contractInterface.fragments
  .filter((fragment): fragment is EventFragment => fragment.type === 'event')
  .map((fragment) => fragment.format('sighash'))
  .sort();

export const ESCROW_EVENT_TOPICS = ESCROW_EVENT_SIGNATURES.map((signature) => keccakId(signature));
