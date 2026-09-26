
# Group


## Properties

Name | Type
------------ | -------------
`id` | string
`gatewayGroupId` | string
`status` | string
`creatorAccountId` | string
`agentEnabled` | boolean
`autoKickEnabled` | boolean
`members` | [Array&lt;GroupMember&gt;](GroupMember.md)
`activeSequenceRunId` | string
`activeAgentRunId` | string

## Example

```typescript
import type { Group } from ''

// TODO: Update the object below with actual values
const example = {
  "id": null,
  "gatewayGroupId": null,
  "status": null,
  "creatorAccountId": null,
  "agentEnabled": null,
  "autoKickEnabled": null,
  "members": null,
  "activeSequenceRunId": null,
  "activeAgentRunId": null,
} satisfies Group

console.log(example)

// Convert the instance to a JSON string
const exampleJSON: string = JSON.stringify(example)
console.log(exampleJSON)

// Parse the JSON string back to an object
const exampleParsed = JSON.parse(exampleJSON) as Group
console.log(exampleParsed)
```

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


