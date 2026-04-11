import { Interface } from 'ethers';
import AgroasysEscrowArtifact from './abi/AgroasysEscrow.json';

export const contractInterface = new Interface(AgroasysEscrowArtifact.abi);
