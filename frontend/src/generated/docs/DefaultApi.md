# DefaultApi

All URIs are relative to *http://localhost*

| Method | HTTP request | Description |
|------------- | ------------- | -------------|
| [**approveGroupJoinRequest**](DefaultApi.md#approvegroupjoinrequest) | **POST** /api/groups/{id}/join-requests/{requestId}/approve |  |
| [**connectAccount**](DefaultApi.md#connectaccount) | **POST** /api/accounts/{id}/connect |  |
| [**createAccount**](DefaultApi.md#createaccountoperation) | **POST** /api/accounts |  |
| [**createGroup**](DefaultApi.md#creategroupoperation) | **POST** /api/groups |  |
| [**createGroupJoinRequest**](DefaultApi.md#creategroupjoinrequest) | **POST** /api/groups/{id}/join-requests |  |
| [**createSequence**](DefaultApi.md#createsequence) | **POST** /api/sequences |  |
| [**deleteAccount**](DefaultApi.md#deleteaccount) | **DELETE** /api/accounts/{id} |  |
| [**downloadMedia**](DefaultApi.md#downloadmedia) | **GET** /api/media/{id} |  |
| [**getAccount**](DefaultApi.md#getaccount) | **GET** /api/accounts/{id} |  |
| [**getActiveSequenceRun**](DefaultApi.md#getactivesequencerun) | **GET** /api/groups/{id}/sequence-runs/active |  |
| [**getAgentRun**](DefaultApi.md#getagentrun) | **GET** /api/agent-runs/{id} |  |
| [**getAgentSimulation**](DefaultApi.md#getagentsimulation) | **GET** /api/agent-simulation |  |
| [**getGroup**](DefaultApi.md#getgroup) | **GET** /api/groups/{id} |  |
| [**getHealth**](DefaultApi.md#gethealth) | **GET** /api/health |  |
| [**getJob**](DefaultApi.md#getjob) | **GET** /api/jobs/{id} |  |
| [**getSequence**](DefaultApi.md#getsequence) | **GET** /api/sequences/{id} |  |
| [**getSequenceRun**](DefaultApi.md#getsequencerun) | **GET** /api/sequence-runs/{id} |  |
| [**getTrace**](DefaultApi.md#gettrace) | **GET** /api/traces/{traceId} |  |
| [**inviteGroupMember**](DefaultApi.md#invitegroupmember) | **POST** /api/groups/{id}/members/invite |  |
| [**joinGroupMember**](DefaultApi.md#joingroupmember) | **POST** /api/groups/{id}/members/join |  |
| [**kickGroupMember**](DefaultApi.md#kickgroupmemberoperation) | **POST** /api/groups/{id}/members/kick |  |
| [**leaveAll**](DefaultApi.md#leaveall) | **POST** /api/groups/{id}/leave-all |  |
| [**leaveGroupMember**](DefaultApi.md#leavegroupmemberoperation) | **POST** /api/groups/{id}/members/leave |  |
| [**listAccounts**](DefaultApi.md#listaccounts) | **GET** /api/accounts |  |
| [**listAgentRuns**](DefaultApi.md#listagentruns) | **GET** /api/groups/{id}/agent-runs |  |
| [**listGroupJoinRequests**](DefaultApi.md#listgroupjoinrequests) | **GET** /api/groups/{id}/join-requests |  |
| [**listGroups**](DefaultApi.md#listgroups) | **GET** /api/groups |  |
| [**listMessages**](DefaultApi.md#listmessages) | **GET** /api/groups/{id}/messages |  |
| [**listSequenceRuns**](DefaultApi.md#listsequenceruns) | **GET** /api/groups/{id}/sequence-runs |  |
| [**listSequences**](DefaultApi.md#listsequences) | **GET** /api/sequences |  |
| [**login**](DefaultApi.md#loginoperation) | **POST** /api/auth/login |  |
| [**logout**](DefaultApi.md#logout) | **POST** /api/auth/logout |  |
| [**patchGroup**](DefaultApi.md#patchgroup) | **PATCH** /api/groups/{id} |  |
| [**previewSequence**](DefaultApi.md#previewsequence) | **POST** /api/sequences/preview |  |
| [**promoteGroupMember**](DefaultApi.md#promotegroupmember) | **POST** /api/groups/{id}/members/promote |  |
| [**refresh**](DefaultApi.md#refresh) | **POST** /api/auth/refresh |  |
| [**rejectGroupJoinRequest**](DefaultApi.md#rejectgroupjoinrequest) | **POST** /api/groups/{id}/join-requests/{requestId}/reject |  |
| [**sendMessage**](DefaultApi.md#sendmessage) | **POST** /api/groups/{id}/send |  |
| [**simulateExternalMessage**](DefaultApi.md#simulateexternalmessageoperation) | **POST** /api/groups/{id}/agent-simulation/messages |  |
| [**startSequence**](DefaultApi.md#startsequence) | **POST** /api/groups/{id}/sequence-runs |  |
| [**transitionAccount**](DefaultApi.md#transitionaccount) | **POST** /api/accounts/{id}/transition |  |
| [**updateAccount**](DefaultApi.md#updateaccountoperation) | **PATCH** /api/accounts/{id} |  |
| [**updateSequence**](DefaultApi.md#updatesequence) | **PATCH** /api/sequences/{id} |  |



## approveGroupJoinRequest

> GroupJoinRequest approveGroupJoinRequest(id, requestId)



### Example

```ts
import {
  Configuration,
  DefaultApi,
} from '';
import type { ApproveGroupJoinRequestRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const config = new Configuration({
    // Configure HTTP bearer authorization: bearerAuth
    accessToken: "YOUR BEARER TOKEN",
  });
  const api = new DefaultApi(config);

  const body = {
    // string
    id: id_example,
    // string
    requestId: requestId_example,
  } satisfies ApproveGroupJoinRequestRequest;

  try {
    const data = await api.approveGroupJoinRequest(body);
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters


| Name | Type | Description  | Notes |
|------------- | ------------- | ------------- | -------------|
| **id** | `string` |  | [Defaults to `undefined`] |
| **requestId** | `string` |  | [Defaults to `undefined`] |

### Return type

[**GroupJoinRequest**](GroupJoinRequest.md)

### Authorization

[bearerAuth](../README.md#bearerAuth)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | Approved; gateway join starts asynchronously |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## connectAccount

> ConnectAccount200Response connectAccount(id)



### Example

```ts
import {
  Configuration,
  DefaultApi,
} from '';
import type { ConnectAccountRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const config = new Configuration({
    // Configure HTTP bearer authorization: bearerAuth
    accessToken: "YOUR BEARER TOKEN",
  });
  const api = new DefaultApi(config);

  const body = {
    // string
    id: id_example,
  } satisfies ConnectAccountRequest;

  try {
    const data = await api.connectAccount(body);
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters


| Name | Type | Description  | Notes |
|------------- | ------------- | ------------- | -------------|
| **id** | `string` |  | [Defaults to `undefined`] |

### Return type

[**ConnectAccount200Response**](ConnectAccount200Response.md)

### Authorization

[bearerAuth](../README.md#bearerAuth)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## createAccount

> Account createAccount(createAccountRequest)



### Example

```ts
import {
  Configuration,
  DefaultApi,
} from '';
import type { CreateAccountOperationRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const config = new Configuration({
    // Configure HTTP bearer authorization: bearerAuth
    accessToken: "YOUR BEARER TOKEN",
  });
  const api = new DefaultApi(config);

  const body = {
    // CreateAccountRequest
    createAccountRequest: ...,
  } satisfies CreateAccountOperationRequest;

  try {
    const data = await api.createAccount(body);
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters


| Name | Type | Description  | Notes |
|------------- | ------------- | ------------- | -------------|
| **createAccountRequest** | [CreateAccountRequest](CreateAccountRequest.md) |  | |

### Return type

[**Account**](Account.md)

### Authorization

[bearerAuth](../README.md#bearerAuth)

### HTTP request headers

- **Content-Type**: `application/json`
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **201** | Created |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## createGroup

> JobId createGroup(createGroupRequest)



### Example

```ts
import {
  Configuration,
  DefaultApi,
} from '';
import type { CreateGroupOperationRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const config = new Configuration({
    // Configure HTTP bearer authorization: bearerAuth
    accessToken: "YOUR BEARER TOKEN",
  });
  const api = new DefaultApi(config);

  const body = {
    // CreateGroupRequest
    createGroupRequest: ...,
  } satisfies CreateGroupOperationRequest;

  try {
    const data = await api.createGroup(body);
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters


| Name | Type | Description  | Notes |
|------------- | ------------- | ------------- | -------------|
| **createGroupRequest** | [CreateGroupRequest](CreateGroupRequest.md) |  | |

### Return type

[**JobId**](JobId.md)

### Authorization

[bearerAuth](../README.md#bearerAuth)

### HTTP request headers

- **Content-Type**: `application/json`
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **202** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## createGroupJoinRequest

> GroupJoinRequest createGroupJoinRequest(id, createJoinRequest)



### Example

```ts
import {
  Configuration,
  DefaultApi,
} from '';
import type { CreateGroupJoinRequestRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const config = new Configuration({
    // Configure HTTP bearer authorization: bearerAuth
    accessToken: "YOUR BEARER TOKEN",
  });
  const api = new DefaultApi(config);

  const body = {
    // string
    id: id_example,
    // CreateJoinRequest
    createJoinRequest: ...,
  } satisfies CreateGroupJoinRequestRequest;

  try {
    const data = await api.createGroupJoinRequest(body);
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters


| Name | Type | Description  | Notes |
|------------- | ------------- | ------------- | -------------|
| **id** | `string` |  | [Defaults to `undefined`] |
| **createJoinRequest** | [CreateJoinRequest](CreateJoinRequest.md) |  | |

### Return type

[**GroupJoinRequest**](GroupJoinRequest.md)

### Authorization

[bearerAuth](../README.md#bearerAuth)

### HTTP request headers

- **Content-Type**: `application/json`
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **201** | Submitted for operator approval |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## createSequence

> SequenceId createSequence(sequenceInput)



### Example

```ts
import {
  Configuration,
  DefaultApi,
} from '';
import type { CreateSequenceRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const config = new Configuration({
    // Configure HTTP bearer authorization: bearerAuth
    accessToken: "YOUR BEARER TOKEN",
  });
  const api = new DefaultApi(config);

  const body = {
    // SequenceInput
    sequenceInput: ...,
  } satisfies CreateSequenceRequest;

  try {
    const data = await api.createSequence(body);
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters


| Name | Type | Description  | Notes |
|------------- | ------------- | ------------- | -------------|
| **sequenceInput** | [SequenceInput](SequenceInput.md) |  | |

### Return type

[**SequenceId**](SequenceId.md)

### Authorization

[bearerAuth](../README.md#bearerAuth)

### HTTP request headers

- **Content-Type**: `application/json`
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## deleteAccount

> DeleteAccount200Response deleteAccount(id)



### Example

```ts
import {
  Configuration,
  DefaultApi,
} from '';
import type { DeleteAccountRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const config = new Configuration({
    // Configure HTTP bearer authorization: bearerAuth
    accessToken: "YOUR BEARER TOKEN",
  });
  const api = new DefaultApi(config);

  const body = {
    // string
    id: id_example,
  } satisfies DeleteAccountRequest;

  try {
    const data = await api.deleteAccount(body);
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters


| Name | Type | Description  | Notes |
|------------- | ------------- | ------------- | -------------|
| **id** | `string` |  | [Defaults to `undefined`] |

### Return type

[**DeleteAccount200Response**](DeleteAccount200Response.md)

### Authorization

[bearerAuth](../README.md#bearerAuth)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | Deleted |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## downloadMedia

> Blob downloadMedia(id)



### Example

```ts
import {
  Configuration,
  DefaultApi,
} from '';
import type { DownloadMediaRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const config = new Configuration({
    // Configure HTTP bearer authorization: bearerAuth
    accessToken: "YOUR BEARER TOKEN",
  });
  const api = new DefaultApi(config);

  const body = {
    // string
    id: id_example,
  } satisfies DownloadMediaRequest;

  try {
    const data = await api.downloadMedia(body);
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters


| Name | Type | Description  | Notes |
|------------- | ------------- | ------------- | -------------|
| **id** | `string` |  | [Defaults to `undefined`] |

### Return type

**Blob**

### Authorization

[bearerAuth](../README.md#bearerAuth)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: `application/octet-stream`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | Downloaded media |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## getAccount

> Account getAccount(id)



### Example

```ts
import {
  Configuration,
  DefaultApi,
} from '';
import type { GetAccountRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const config = new Configuration({
    // Configure HTTP bearer authorization: bearerAuth
    accessToken: "YOUR BEARER TOKEN",
  });
  const api = new DefaultApi(config);

  const body = {
    // string
    id: id_example,
  } satisfies GetAccountRequest;

  try {
    const data = await api.getAccount(body);
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters


| Name | Type | Description  | Notes |
|------------- | ------------- | ------------- | -------------|
| **id** | `string` |  | [Defaults to `undefined`] |

### Return type

[**Account**](Account.md)

### Authorization

[bearerAuth](../README.md#bearerAuth)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## getActiveSequenceRun

> ActiveSequenceRun getActiveSequenceRun(id)



### Example

```ts
import {
  Configuration,
  DefaultApi,
} from '';
import type { GetActiveSequenceRunRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const config = new Configuration({
    // Configure HTTP bearer authorization: bearerAuth
    accessToken: "YOUR BEARER TOKEN",
  });
  const api = new DefaultApi(config);

  const body = {
    // string
    id: id_example,
  } satisfies GetActiveSequenceRunRequest;

  try {
    const data = await api.getActiveSequenceRun(body);
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters


| Name | Type | Description  | Notes |
|------------- | ------------- | ------------- | -------------|
| **id** | `string` |  | [Defaults to `undefined`] |

### Return type

[**ActiveSequenceRun**](ActiveSequenceRun.md)

### Authorization

[bearerAuth](../README.md#bearerAuth)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | Current run for the group, if any |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## getAgentRun

> AgentRun getAgentRun(id)



### Example

```ts
import {
  Configuration,
  DefaultApi,
} from '';
import type { GetAgentRunRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const config = new Configuration({
    // Configure HTTP bearer authorization: bearerAuth
    accessToken: "YOUR BEARER TOKEN",
  });
  const api = new DefaultApi(config);

  const body = {
    // string
    id: id_example,
  } satisfies GetAgentRunRequest;

  try {
    const data = await api.getAgentRun(body);
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters


| Name | Type | Description  | Notes |
|------------- | ------------- | ------------- | -------------|
| **id** | `string` |  | [Defaults to `undefined`] |

### Return type

[**AgentRun**](AgentRun.md)

### Authorization

[bearerAuth](../README.md#bearerAuth)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## getAgentSimulation

> GetAgentSimulation200Response getAgentSimulation()



### Example

```ts
import {
  Configuration,
  DefaultApi,
} from '';
import type { GetAgentSimulationRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const config = new Configuration({
    // Configure HTTP bearer authorization: bearerAuth
    accessToken: "YOUR BEARER TOKEN",
  });
  const api = new DefaultApi(config);

  try {
    const data = await api.getAgentSimulation();
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters

This endpoint does not need any parameter.

### Return type

[**GetAgentSimulation200Response**](GetAgentSimulation200Response.md)

### Authorization

[bearerAuth](../README.md#bearerAuth)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | Whether the local mock gateway simulation is enabled |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## getGroup

> Group getGroup(id)



### Example

```ts
import {
  Configuration,
  DefaultApi,
} from '';
import type { GetGroupRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const config = new Configuration({
    // Configure HTTP bearer authorization: bearerAuth
    accessToken: "YOUR BEARER TOKEN",
  });
  const api = new DefaultApi(config);

  const body = {
    // string
    id: id_example,
  } satisfies GetGroupRequest;

  try {
    const data = await api.getGroup(body);
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters


| Name | Type | Description  | Notes |
|------------- | ------------- | ------------- | -------------|
| **id** | `string` |  | [Defaults to `undefined`] |

### Return type

[**Group**](Group.md)

### Authorization

[bearerAuth](../README.md#bearerAuth)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## getHealth

> Health getHealth()



### Example

```ts
import {
  Configuration,
  DefaultApi,
} from '';
import type { GetHealthRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const api = new DefaultApi();

  try {
    const data = await api.getHealth();
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters

This endpoint does not need any parameter.

### Return type

[**Health**](Health.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## getJob

> Job getJob(id)



### Example

```ts
import {
  Configuration,
  DefaultApi,
} from '';
import type { GetJobRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const config = new Configuration({
    // Configure HTTP bearer authorization: bearerAuth
    accessToken: "YOUR BEARER TOKEN",
  });
  const api = new DefaultApi(config);

  const body = {
    // string
    id: id_example,
  } satisfies GetJobRequest;

  try {
    const data = await api.getJob(body);
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters


| Name | Type | Description  | Notes |
|------------- | ------------- | ------------- | -------------|
| **id** | `string` |  | [Defaults to `undefined`] |

### Return type

[**Job**](Job.md)

### Authorization

[bearerAuth](../README.md#bearerAuth)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## getSequence

> Sequence getSequence(id)



### Example

```ts
import {
  Configuration,
  DefaultApi,
} from '';
import type { GetSequenceRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const config = new Configuration({
    // Configure HTTP bearer authorization: bearerAuth
    accessToken: "YOUR BEARER TOKEN",
  });
  const api = new DefaultApi(config);

  const body = {
    // string
    id: 38400000-8cf0-11bd-b23e-10b96e4ef00d,
  } satisfies GetSequenceRequest;

  try {
    const data = await api.getSequence(body);
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters


| Name | Type | Description  | Notes |
|------------- | ------------- | ------------- | -------------|
| **id** | `string` |  | [Defaults to `undefined`] |

### Return type

[**Sequence**](Sequence.md)

### Authorization

[bearerAuth](../README.md#bearerAuth)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | Sequence template |  -  |
| **404** | Sequence not found |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## getSequenceRun

> SequenceRun getSequenceRun(id)



### Example

```ts
import {
  Configuration,
  DefaultApi,
} from '';
import type { GetSequenceRunRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const config = new Configuration({
    // Configure HTTP bearer authorization: bearerAuth
    accessToken: "YOUR BEARER TOKEN",
  });
  const api = new DefaultApi(config);

  const body = {
    // string
    id: id_example,
  } satisfies GetSequenceRunRequest;

  try {
    const data = await api.getSequenceRun(body);
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters


| Name | Type | Description  | Notes |
|------------- | ------------- | ------------- | -------------|
| **id** | `string` |  | [Defaults to `undefined`] |

### Return type

[**SequenceRun**](SequenceRun.md)

### Authorization

[bearerAuth](../README.md#bearerAuth)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## getTrace

> TraceResponse getTrace(traceId)



### Example

```ts
import {
  Configuration,
  DefaultApi,
} from '';
import type { GetTraceRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const config = new Configuration({
    // Configure HTTP bearer authorization: bearerAuth
    accessToken: "YOUR BEARER TOKEN",
  });
  const api = new DefaultApi(config);

  const body = {
    // string
    traceId: traceId_example,
  } satisfies GetTraceRequest;

  try {
    const data = await api.getTrace(body);
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters


| Name | Type | Description  | Notes |
|------------- | ------------- | ------------- | -------------|
| **traceId** | `string` |  | [Defaults to `undefined`] |

### Return type

[**TraceResponse**](TraceResponse.md)

### Authorization

[bearerAuth](../README.md#bearerAuth)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | Trace event chain |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## inviteGroupMember

> InviteResponse inviteGroupMember(id)



### Example

```ts
import {
  Configuration,
  DefaultApi,
} from '';
import type { InviteGroupMemberRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const config = new Configuration({
    // Configure HTTP bearer authorization: bearerAuth
    accessToken: "YOUR BEARER TOKEN",
  });
  const api = new DefaultApi(config);

  const body = {
    // string
    id: id_example,
  } satisfies InviteGroupMemberRequest;

  try {
    const data = await api.inviteGroupMember(body);
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters


| Name | Type | Description  | Notes |
|------------- | ------------- | ------------- | -------------|
| **id** | `string` |  | [Defaults to `undefined`] |

### Return type

[**InviteResponse**](InviteResponse.md)

### Authorization

[bearerAuth](../README.md#bearerAuth)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## joinGroupMember

> JoinAccepted joinGroupMember(id, joinRequest)



### Example

```ts
import {
  Configuration,
  DefaultApi,
} from '';
import type { JoinGroupMemberRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const config = new Configuration({
    // Configure HTTP bearer authorization: bearerAuth
    accessToken: "YOUR BEARER TOKEN",
  });
  const api = new DefaultApi(config);

  const body = {
    // string
    id: id_example,
    // JoinRequest
    joinRequest: ...,
  } satisfies JoinGroupMemberRequest;

  try {
    const data = await api.joinGroupMember(body);
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters


| Name | Type | Description  | Notes |
|------------- | ------------- | ------------- | -------------|
| **id** | `string` |  | [Defaults to `undefined`] |
| **joinRequest** | [JoinRequest](JoinRequest.md) |  | |

### Return type

[**JoinAccepted**](JoinAccepted.md)

### Authorization

[bearerAuth](../README.md#bearerAuth)

### HTTP request headers

- **Content-Type**: `application/json`
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **202** | Accepted |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## kickGroupMember

> KickResponse kickGroupMember(id, kickGroupMemberRequest)



### Example

```ts
import {
  Configuration,
  DefaultApi,
} from '';
import type { KickGroupMemberOperationRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const config = new Configuration({
    // Configure HTTP bearer authorization: bearerAuth
    accessToken: "YOUR BEARER TOKEN",
  });
  const api = new DefaultApi(config);

  const body = {
    // string
    id: id_example,
    // KickGroupMemberRequest
    kickGroupMemberRequest: ...,
  } satisfies KickGroupMemberOperationRequest;

  try {
    const data = await api.kickGroupMember(body);
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters


| Name | Type | Description  | Notes |
|------------- | ------------- | ------------- | -------------|
| **id** | `string` |  | [Defaults to `undefined`] |
| **kickGroupMemberRequest** | [KickGroupMemberRequest](KickGroupMemberRequest.md) |  | |

### Return type

[**KickResponse**](KickResponse.md)

### Authorization

[bearerAuth](../README.md#bearerAuth)

### HTTP request headers

- **Content-Type**: `application/json`
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## leaveAll

> JobId leaveAll(id)



### Example

```ts
import {
  Configuration,
  DefaultApi,
} from '';
import type { LeaveAllRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const config = new Configuration({
    // Configure HTTP bearer authorization: bearerAuth
    accessToken: "YOUR BEARER TOKEN",
  });
  const api = new DefaultApi(config);

  const body = {
    // string
    id: id_example,
  } satisfies LeaveAllRequest;

  try {
    const data = await api.leaveAll(body);
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters


| Name | Type | Description  | Notes |
|------------- | ------------- | ------------- | -------------|
| **id** | `string` |  | [Defaults to `undefined`] |

### Return type

[**JobId**](JobId.md)

### Authorization

[bearerAuth](../README.md#bearerAuth)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **202** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## leaveGroupMember

> leaveGroupMember(id, leaveGroupMemberRequest)



### Example

```ts
import {
  Configuration,
  DefaultApi,
} from '';
import type { LeaveGroupMemberOperationRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const config = new Configuration({
    // Configure HTTP bearer authorization: bearerAuth
    accessToken: "YOUR BEARER TOKEN",
  });
  const api = new DefaultApi(config);

  const body = {
    // string
    id: id_example,
    // LeaveGroupMemberRequest
    leaveGroupMemberRequest: ...,
  } satisfies LeaveGroupMemberOperationRequest;

  try {
    const data = await api.leaveGroupMember(body);
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters


| Name | Type | Description  | Notes |
|------------- | ------------- | ------------- | -------------|
| **id** | `string` |  | [Defaults to `undefined`] |
| **leaveGroupMemberRequest** | [LeaveGroupMemberRequest](LeaveGroupMemberRequest.md) |  | |

### Return type

`void` (Empty response body)

### Authorization

[bearerAuth](../README.md#bearerAuth)

### HTTP request headers

- **Content-Type**: `application/json`
- **Accept**: Not defined


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## listAccounts

> Array&lt;Account&gt; listAccounts()



### Example

```ts
import {
  Configuration,
  DefaultApi,
} from '';
import type { ListAccountsRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const config = new Configuration({
    // Configure HTTP bearer authorization: bearerAuth
    accessToken: "YOUR BEARER TOKEN",
  });
  const api = new DefaultApi(config);

  try {
    const data = await api.listAccounts();
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters

This endpoint does not need any parameter.

### Return type

[**Array&lt;Account&gt;**](Account.md)

### Authorization

[bearerAuth](../README.md#bearerAuth)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## listAgentRuns

> Array&lt;AgentRun&gt; listAgentRuns(id)



### Example

```ts
import {
  Configuration,
  DefaultApi,
} from '';
import type { ListAgentRunsRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const config = new Configuration({
    // Configure HTTP bearer authorization: bearerAuth
    accessToken: "YOUR BEARER TOKEN",
  });
  const api = new DefaultApi(config);

  const body = {
    // string
    id: id_example,
  } satisfies ListAgentRunsRequest;

  try {
    const data = await api.listAgentRuns(body);
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters


| Name | Type | Description  | Notes |
|------------- | ------------- | ------------- | -------------|
| **id** | `string` |  | [Defaults to `undefined`] |

### Return type

[**Array&lt;AgentRun&gt;**](AgentRun.md)

### Authorization

[bearerAuth](../README.md#bearerAuth)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## listGroupJoinRequests

> Array&lt;GroupJoinRequest&gt; listGroupJoinRequests(id)



### Example

```ts
import {
  Configuration,
  DefaultApi,
} from '';
import type { ListGroupJoinRequestsRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const config = new Configuration({
    // Configure HTTP bearer authorization: bearerAuth
    accessToken: "YOUR BEARER TOKEN",
  });
  const api = new DefaultApi(config);

  const body = {
    // string
    id: id_example,
  } satisfies ListGroupJoinRequestsRequest;

  try {
    const data = await api.listGroupJoinRequests(body);
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters


| Name | Type | Description  | Notes |
|------------- | ------------- | ------------- | -------------|
| **id** | `string` |  | [Defaults to `undefined`] |

### Return type

[**Array&lt;GroupJoinRequest&gt;**](GroupJoinRequest.md)

### Authorization

[bearerAuth](../README.md#bearerAuth)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | Group join requests |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## listGroups

> Array&lt;Group&gt; listGroups()



### Example

```ts
import {
  Configuration,
  DefaultApi,
} from '';
import type { ListGroupsRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const config = new Configuration({
    // Configure HTTP bearer authorization: bearerAuth
    accessToken: "YOUR BEARER TOKEN",
  });
  const api = new DefaultApi(config);

  try {
    const data = await api.listGroups();
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters

This endpoint does not need any parameter.

### Return type

[**Array&lt;Group&gt;**](Group.md)

### Authorization

[bearerAuth](../README.md#bearerAuth)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## listMessages

> MessagePage listMessages(id, before, limit)



### Example

```ts
import {
  Configuration,
  DefaultApi,
} from '';
import type { ListMessagesRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const config = new Configuration({
    // Configure HTTP bearer authorization: bearerAuth
    accessToken: "YOUR BEARER TOKEN",
  });
  const api = new DefaultApi(config);

  const body = {
    // string
    id: id_example,
    // string (optional)
    before: before_example,
    // number (optional)
    limit: 56,
  } satisfies ListMessagesRequest;

  try {
    const data = await api.listMessages(body);
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters


| Name | Type | Description  | Notes |
|------------- | ------------- | ------------- | -------------|
| **id** | `string` |  | [Defaults to `undefined`] |
| **before** | `string` |  | [Optional] [Defaults to `undefined`] |
| **limit** | `number` |  | [Optional] [Defaults to `undefined`] |

### Return type

[**MessagePage**](MessagePage.md)

### Authorization

[bearerAuth](../README.md#bearerAuth)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## listSequenceRuns

> SequenceRunPage listSequenceRuns(id, sequenceId, before, limit)



### Example

```ts
import {
  Configuration,
  DefaultApi,
} from '';
import type { ListSequenceRunsRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const config = new Configuration({
    // Configure HTTP bearer authorization: bearerAuth
    accessToken: "YOUR BEARER TOKEN",
  });
  const api = new DefaultApi(config);

  const body = {
    // string
    id: id_example,
    // string (optional)
    sequenceId: sequenceId_example,
    // string (optional)
    before: before_example,
    // number (optional)
    limit: 56,
  } satisfies ListSequenceRunsRequest;

  try {
    const data = await api.listSequenceRuns(body);
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters


| Name | Type | Description  | Notes |
|------------- | ------------- | ------------- | -------------|
| **id** | `string` |  | [Defaults to `undefined`] |
| **sequenceId** | `string` |  | [Optional] [Defaults to `undefined`] |
| **before** | `string` |  | [Optional] [Defaults to `undefined`] |
| **limit** | `number` |  | [Optional] [Defaults to `undefined`] |

### Return type

[**SequenceRunPage**](SequenceRunPage.md)

### Authorization

[bearerAuth](../README.md#bearerAuth)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | Paginated sequence run history |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## listSequences

> Array&lt;Sequence&gt; listSequences()



### Example

```ts
import {
  Configuration,
  DefaultApi,
} from '';
import type { ListSequencesRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const config = new Configuration({
    // Configure HTTP bearer authorization: bearerAuth
    accessToken: "YOUR BEARER TOKEN",
  });
  const api = new DefaultApi(config);

  try {
    const data = await api.listSequences();
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters

This endpoint does not need any parameter.

### Return type

[**Array&lt;Sequence&gt;**](Sequence.md)

### Authorization

[bearerAuth](../README.md#bearerAuth)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## login

> AccessToken login(loginRequest)



### Example

```ts
import {
  Configuration,
  DefaultApi,
} from '';
import type { LoginOperationRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const api = new DefaultApi();

  const body = {
    // LoginRequest
    loginRequest: ...,
  } satisfies LoginOperationRequest;

  try {
    const data = await api.login(body);
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters


| Name | Type | Description  | Notes |
|------------- | ------------- | ------------- | -------------|
| **loginRequest** | [LoginRequest](LoginRequest.md) |  | |

### Return type

[**AccessToken**](AccessToken.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: `application/json`
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## logout

> Logout200Response logout()



### Example

```ts
import {
  Configuration,
  DefaultApi,
} from '';
import type { LogoutRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const config = new Configuration({
    // Configure HTTP bearer authorization: bearerAuth
    accessToken: "YOUR BEARER TOKEN",
  });
  const api = new DefaultApi(config);

  try {
    const data = await api.logout();
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters

This endpoint does not need any parameter.

### Return type

[**Logout200Response**](Logout200Response.md)

### Authorization

[bearerAuth](../README.md#bearerAuth)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## patchGroup

> Logout200Response patchGroup(id, groupPatch)



### Example

```ts
import {
  Configuration,
  DefaultApi,
} from '';
import type { PatchGroupRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const config = new Configuration({
    // Configure HTTP bearer authorization: bearerAuth
    accessToken: "YOUR BEARER TOKEN",
  });
  const api = new DefaultApi(config);

  const body = {
    // string
    id: id_example,
    // GroupPatch
    groupPatch: ...,
  } satisfies PatchGroupRequest;

  try {
    const data = await api.patchGroup(body);
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters


| Name | Type | Description  | Notes |
|------------- | ------------- | ------------- | -------------|
| **id** | `string` |  | [Defaults to `undefined`] |
| **groupPatch** | [GroupPatch](GroupPatch.md) |  | |

### Return type

[**Logout200Response**](Logout200Response.md)

### Authorization

[bearerAuth](../README.md#bearerAuth)

### HTTP request headers

- **Content-Type**: `application/json`
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## previewSequence

> SequencePreview previewSequence(sequencePreviewInput)



### Example

```ts
import {
  Configuration,
  DefaultApi,
} from '';
import type { PreviewSequenceRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const config = new Configuration({
    // Configure HTTP bearer authorization: bearerAuth
    accessToken: "YOUR BEARER TOKEN",
  });
  const api = new DefaultApi(config);

  const body = {
    // SequencePreviewInput
    sequencePreviewInput: ...,
  } satisfies PreviewSequenceRequest;

  try {
    const data = await api.previewSequence(body);
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters


| Name | Type | Description  | Notes |
|------------- | ------------- | ------------- | -------------|
| **sequencePreviewInput** | [SequencePreviewInput](SequencePreviewInput.md) |  | |

### Return type

[**SequencePreview**](SequencePreview.md)

### Authorization

[bearerAuth](../README.md#bearerAuth)

### HTTP request headers

- **Content-Type**: `application/json`
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | Resolved steps without starting a run |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## promoteGroupMember

> promoteGroupMember(id, promoteRequest)



### Example

```ts
import {
  Configuration,
  DefaultApi,
} from '';
import type { PromoteGroupMemberRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const config = new Configuration({
    // Configure HTTP bearer authorization: bearerAuth
    accessToken: "YOUR BEARER TOKEN",
  });
  const api = new DefaultApi(config);

  const body = {
    // string
    id: id_example,
    // PromoteRequest
    promoteRequest: ...,
  } satisfies PromoteGroupMemberRequest;

  try {
    const data = await api.promoteGroupMember(body);
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters


| Name | Type | Description  | Notes |
|------------- | ------------- | ------------- | -------------|
| **id** | `string` |  | [Defaults to `undefined`] |
| **promoteRequest** | [PromoteRequest](PromoteRequest.md) |  | |

### Return type

`void` (Empty response body)

### Authorization

[bearerAuth](../README.md#bearerAuth)

### HTTP request headers

- **Content-Type**: `application/json`
- **Accept**: Not defined


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## refresh

> AccessToken refresh()



### Example

```ts
import {
  Configuration,
  DefaultApi,
} from '';
import type { RefreshRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const api = new DefaultApi();

  try {
    const data = await api.refresh();
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters

This endpoint does not need any parameter.

### Return type

[**AccessToken**](AccessToken.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## rejectGroupJoinRequest

> GroupJoinRequest rejectGroupJoinRequest(id, requestId)



### Example

```ts
import {
  Configuration,
  DefaultApi,
} from '';
import type { RejectGroupJoinRequestRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const config = new Configuration({
    // Configure HTTP bearer authorization: bearerAuth
    accessToken: "YOUR BEARER TOKEN",
  });
  const api = new DefaultApi(config);

  const body = {
    // string
    id: id_example,
    // string
    requestId: requestId_example,
  } satisfies RejectGroupJoinRequestRequest;

  try {
    const data = await api.rejectGroupJoinRequest(body);
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters


| Name | Type | Description  | Notes |
|------------- | ------------- | ------------- | -------------|
| **id** | `string` |  | [Defaults to `undefined`] |
| **requestId** | `string` |  | [Defaults to `undefined`] |

### Return type

[**GroupJoinRequest**](GroupJoinRequest.md)

### Authorization

[bearerAuth](../README.md#bearerAuth)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | Rejected without contacting the gateway |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## sendMessage

> SendAccepted sendMessage(id, sendRequest)



### Example

```ts
import {
  Configuration,
  DefaultApi,
} from '';
import type { SendMessageRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const config = new Configuration({
    // Configure HTTP bearer authorization: bearerAuth
    accessToken: "YOUR BEARER TOKEN",
  });
  const api = new DefaultApi(config);

  const body = {
    // string
    id: id_example,
    // SendRequest
    sendRequest: ...,
  } satisfies SendMessageRequest;

  try {
    const data = await api.sendMessage(body);
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters


| Name | Type | Description  | Notes |
|------------- | ------------- | ------------- | -------------|
| **id** | `string` |  | [Defaults to `undefined`] |
| **sendRequest** | [SendRequest](SendRequest.md) |  | |

### Return type

[**SendAccepted**](SendAccepted.md)

### Authorization

[bearerAuth](../README.md#bearerAuth)

### HTTP request headers

- **Content-Type**: `application/json`
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **202** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## simulateExternalMessage

> SimulateExternalMessage202Response simulateExternalMessage(id, simulateExternalMessageRequest)



### Example

```ts
import {
  Configuration,
  DefaultApi,
} from '';
import type { SimulateExternalMessageOperationRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const config = new Configuration({
    // Configure HTTP bearer authorization: bearerAuth
    accessToken: "YOUR BEARER TOKEN",
  });
  const api = new DefaultApi(config);

  const body = {
    // string
    id: id_example,
    // SimulateExternalMessageRequest
    simulateExternalMessageRequest: ...,
  } satisfies SimulateExternalMessageOperationRequest;

  try {
    const data = await api.simulateExternalMessage(body);
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters


| Name | Type | Description  | Notes |
|------------- | ------------- | ------------- | -------------|
| **id** | `string` |  | [Defaults to `undefined`] |
| **simulateExternalMessageRequest** | [SimulateExternalMessageRequest](SimulateExternalMessageRequest.md) |  | |

### Return type

[**SimulateExternalMessage202Response**](SimulateExternalMessage202Response.md)

### Authorization

[bearerAuth](../README.md#bearerAuth)

### HTTP request headers

- **Content-Type**: `application/json`
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **202** | External message accepted by the local mock gateway |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## startSequence

> RunId startSequence(id, startSequence)



### Example

```ts
import {
  Configuration,
  DefaultApi,
} from '';
import type { StartSequenceRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const config = new Configuration({
    // Configure HTTP bearer authorization: bearerAuth
    accessToken: "YOUR BEARER TOKEN",
  });
  const api = new DefaultApi(config);

  const body = {
    // string
    id: id_example,
    // StartSequence
    startSequence: ...,
  } satisfies StartSequenceRequest;

  try {
    const data = await api.startSequence(body);
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters


| Name | Type | Description  | Notes |
|------------- | ------------- | ------------- | -------------|
| **id** | `string` |  | [Defaults to `undefined`] |
| **startSequence** | [StartSequence](StartSequence.md) |  | |

### Return type

[**RunId**](RunId.md)

### Authorization

[bearerAuth](../README.md#bearerAuth)

### HTTP request headers

- **Content-Type**: `application/json`
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **201** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## transitionAccount

> TransitionAccount200Response transitionAccount(id, transitionRequest)



### Example

```ts
import {
  Configuration,
  DefaultApi,
} from '';
import type { TransitionAccountRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const config = new Configuration({
    // Configure HTTP bearer authorization: bearerAuth
    accessToken: "YOUR BEARER TOKEN",
  });
  const api = new DefaultApi(config);

  const body = {
    // string
    id: id_example,
    // TransitionRequest
    transitionRequest: ...,
  } satisfies TransitionAccountRequest;

  try {
    const data = await api.transitionAccount(body);
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters


| Name | Type | Description  | Notes |
|------------- | ------------- | ------------- | -------------|
| **id** | `string` |  | [Defaults to `undefined`] |
| **transitionRequest** | [TransitionRequest](TransitionRequest.md) |  | |

### Return type

[**TransitionAccount200Response**](TransitionAccount200Response.md)

### Authorization

[bearerAuth](../README.md#bearerAuth)

### HTTP request headers

- **Content-Type**: `application/json`
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## updateAccount

> Account updateAccount(id, updateAccountRequest)



### Example

```ts
import {
  Configuration,
  DefaultApi,
} from '';
import type { UpdateAccountOperationRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const config = new Configuration({
    // Configure HTTP bearer authorization: bearerAuth
    accessToken: "YOUR BEARER TOKEN",
  });
  const api = new DefaultApi(config);

  const body = {
    // string
    id: id_example,
    // UpdateAccountRequest
    updateAccountRequest: ...,
  } satisfies UpdateAccountOperationRequest;

  try {
    const data = await api.updateAccount(body);
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters


| Name | Type | Description  | Notes |
|------------- | ------------- | ------------- | -------------|
| **id** | `string` |  | [Defaults to `undefined`] |
| **updateAccountRequest** | [UpdateAccountRequest](UpdateAccountRequest.md) |  | |

### Return type

[**Account**](Account.md)

### Authorization

[bearerAuth](../README.md#bearerAuth)

### HTTP request headers

- **Content-Type**: `application/json`
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## updateSequence

> SequenceId updateSequence(id, sequenceInput)



### Example

```ts
import {
  Configuration,
  DefaultApi,
} from '';
import type { UpdateSequenceRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const config = new Configuration({
    // Configure HTTP bearer authorization: bearerAuth
    accessToken: "YOUR BEARER TOKEN",
  });
  const api = new DefaultApi(config);

  const body = {
    // string
    id: 38400000-8cf0-11bd-b23e-10b96e4ef00d,
    // SequenceInput
    sequenceInput: ...,
  } satisfies UpdateSequenceRequest;

  try {
    const data = await api.updateSequence(body);
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters


| Name | Type | Description  | Notes |
|------------- | ------------- | ------------- | -------------|
| **id** | `string` |  | [Defaults to `undefined`] |
| **sequenceInput** | [SequenceInput](SequenceInput.md) |  | |

### Return type

[**SequenceId**](SequenceId.md)

### Authorization

[bearerAuth](../README.md#bearerAuth)

### HTTP request headers

- **Content-Type**: `application/json`
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)

