
# StartSequence


## Properties

Name | Type
------------ | -------------
`sequenceId` | string
`vars` | { [key: string]: string; }
`stepVars` | { [key: string]: { [key: string]: string; }; }
`stepAccountIds` | { [key: string]: string; }

## Example

```typescript
import type { StartSequence } from ''

// TODO: Update the object below with actual values
const example = {
  "sequenceId": null,
  "vars": null,
  "stepVars": null,
  "stepAccountIds": null,
} satisfies StartSequence

console.log(example)

// Convert the instance to a JSON string
const exampleJSON: string = JSON.stringify(example)
console.log(exampleJSON)

// Parse the JSON string back to an object
const exampleParsed = JSON.parse(exampleJSON) as StartSequence
console.log(exampleParsed)
```

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


