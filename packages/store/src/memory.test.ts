import { memoryStore } from './memory.ts'
import { describeStoreContract } from './testing.ts'

describeStoreContract('memory', () => memoryStore())
