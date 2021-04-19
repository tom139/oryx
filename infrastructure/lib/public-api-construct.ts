import * as cdk from '@aws-cdk/core';
import * as apigateway from '@aws-cdk/aws-apigateway';
import * as lambda from '@aws-cdk/aws-lambda';
import * as cognito from '@aws-cdk/aws-cognito';
import * as dynamodb from '@aws-cdk/aws-dynamodb';
import * as iam from '@aws-cdk/aws-iam';

export interface PublicApiConstructProps {
  /**
   * The origins to allow
   * @default '*'
   */
  corsOrigins?: string[];
  articlesTable: dynamodb.Table;
  userPool: cognito.IUserPool;
}

export class PublicApiConstruct extends cdk.Construct {
  constructor(scope: cdk.Construct, id: string, props: PublicApiConstructProps) {
    super(scope, id);

    // create the client infrastructure
    const api = new apigateway.RestApi(this, 'Gateway', {
      apiKeySourceType: apigateway.ApiKeySourceType.HEADER,
      defaultCorsPreflightOptions: {
        allowOrigins: props?.corsOrigins ?? apigateway.Cors.ALL_ORIGINS,
      },
      deployOptions: {
        description: 'Public API for the news aggregator',
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        stageName: 'api',
        throttlingRateLimit: 1000,
        throttlingBurstLimit: 50,
        tracingEnabled: true,
      },
      description: 'Oryx News Aggregator Public REST Gateway',
    });

    const cognitoAuthz = new apigateway.CognitoUserPoolsAuthorizer(this, 'CognitoAuthz', {
      cognitoUserPools: [props.userPool],
    });

    const fullValidator = api.addRequestValidator('BodyValidator', {
      validateRequestBody: true,
      validateRequestParameters: true,
    });

    // ruolo utilizzato dalle integrazioni che fanno query (sola lettura) a dataTable
    const articlesTableReadWriteRole = new iam.Role(this, 'TableQueryRole', {
      assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
    });
    props.articlesTable.grantReadWriteData(articlesTableReadWriteRole);

    // create the lambda to answer to public apis
    const articles = api.root.addResource('articles');
    const getArticles = new apigateway.AwsIntegration({
      service: 'dynamodb',
      action: 'Query',
      options: {
        credentialsRole: articlesTableReadWriteRole,
        passthroughBehavior: apigateway.PassthroughBehavior.NEVER,
        requestTemplates: {
          'application/json': JSON.stringify({
            TableName: props.articlesTable.tableName,
            IndexName: 'GSI1',
            KeyConditionExpression: '#type = :art',
            ExpressionAttributeNames: { '#type': 'type' },
            ExpressionAttributeValues: { ':art': { S: 'ART' } },
            Limit: 30,
          }),
        },
        integrationResponses: [
          {
            statusCode: '200',
            responseTemplates: {
              'application/json': articlesResponseTemplate,
            },
          },
        ],
      },
    });
    articles.addMethod('GET', getArticles, {
      methodResponses: [
        {
          statusCode: '200',
          responseModels: {
            'application/json': apigateway.Model.EMPTY_MODEL,
          },
        },
      ],
    });

    // POST /articles
    const postArticle = new apigateway.AwsIntegration({
      service: 'dynamodb',
      action: 'PutItem',
      options: {
        credentialsRole: articlesTableReadWriteRole,
        passthroughBehavior: apigateway.PassthroughBehavior.NEVER,
        requestTemplates: {
          'application/json': JSON.stringify({
            TableName: props.articlesTable.tableName,
            Item: {
              pk: { S: '$context.requestId' },
              sk: { S: 'ART' },
              link: { S: "$input.path('$.link')" },
              // until title will be auto populated, take the link and strip the first 8 characters
              title: { S: "$input.path('$.link').substring(8)" },
              referrer: { S: '$context.authorizer.claims.email' },
              enriched: { BOOL: false },
              upvotes: { N: '0' },
              date: { S: '$context.requestTimeEpoch' },
              gsi1sk: { S: '$context.requestTimeEpoch' },
              type: { S: 'ART' },
            },
          }),
        },
        integrationResponses: [
          {
            statusCode: '201',
            responseTemplates: {
              'application/json': postArticleResponseTemplate,
            },
          },
          {
            statusCode: '404',
            selectionPattern: '404',
            responseTemplates: {
              'application/json': JSON.stringify({
                message: `article "$input.params('articleId')" not found`,
              }),
            },
          },
        ],
      },
    });
    const requestArticleModel = api.addModel('ReqArticle', {
      schema: {
        type: apigateway.JsonSchemaType.OBJECT,
        properties: {
          link: {
            type: apigateway.JsonSchemaType.STRING,
            pattern: 'https?://[-a-zA-Z0-9@:%._+~#=]{1,256}.[a-zA-Z0-9()]{1,6}\\b([-a-zA-Z0-9()@:%_+.~#?/&=]*)',
          },
        },
        additionalProperties: false,
      },
    });
    articles.addMethod('POST', postArticle, {
      methodResponses: [
        {
          statusCode: '201',
          responseModels: {
            'application/json': apigateway.Model.EMPTY_MODEL,
          },
        },
      ],
      requestModels: {
        'application/json': requestArticleModel,
      },
      requestValidator: fullValidator,
      authorizer: cognitoAuthz,
    });

    // GET /articles/{articleId}
    const article = articles.addResource('{articleId}');
    const getArticle = new apigateway.AwsIntegration({
      service: 'dynamodb',
      action: 'GetItem',
      options: {
        credentialsRole: articlesTableReadWriteRole,
        passthroughBehavior: apigateway.PassthroughBehavior.NEVER,
        requestTemplates: {
          'application/json': JSON.stringify({
            TableName: props.articlesTable.tableName,
            ConsistentRead: false,
            Key: {
              pk: { S: "$input.params('articleId')" },
              sk: { S: 'ART' },
            },
          }),
        },
        integrationResponses: [
          {
            statusCode: '200',
            responseTemplates: {
              'application/json': articleResponseTemplate,
            },
          },
          {
            statusCode: '404',
            selectionPattern: '404',
            responseTemplates: {
              'application/json': JSON.stringify({
                message: `article "$input.params('articleId')" not found`,
              }),
            },
          },
        ],
      },
    });
    article.addMethod('GET', getArticle, {
      methodResponses: [
        {
          statusCode: '200',
          responseModels: {
            'application/json': apigateway.Model.EMPTY_MODEL,
          },
        },
        {
          statusCode: '404',
          responseModels: {
            'application/json': apigateway.Model.ERROR_MODEL,
          },
        },
      ],
    });

    // DELETE /articles/{articleId}
    const deleteArticle = new apigateway.AwsIntegration({
      service: 'dynamodb',
      action: 'DeleteItem',
      options: {
        credentialsRole: articlesTableReadWriteRole,
        passthroughBehavior: apigateway.PassthroughBehavior.NEVER,
        requestTemplates: {
          'application/json': JSON.stringify({
            TableName: props.articlesTable.tableName,
            Key: {
              pk: { S: "$input.params('articleId')" },
              sk: { S: 'ART' },
            },
            ConditionExpression: '#referrer = :caller',
            ExpressionAttributeNames: {
              '#referrer': 'referrer',
            },
            ExpressionAttributeValues: {
              ':caller': { S: '$context.authorizer.claims.email' },
            },
          }),
        },
        integrationResponses: [
          {
            statusCode: '204',
            responseTemplates: {
              'application/json': '',
            },
          },
        ],
      },
    });
    article.addMethod('DELETE', deleteArticle, {
      methodResponses: [
        {
          statusCode: '204',
          responseModels: {
            'application/json': apigateway.Model.EMPTY_MODEL,
          },
        },
        {
          statusCode: '403',
          responseModels: {
            'application/json': apigateway.Model.ERROR_MODEL,
          },
        },
      ],
      authorizer: cognitoAuthz,
    });
  }
}

const articlesResponseTemplate = `
#set( $items = $input.path('$.Items') )
{
  "items":[
    #foreach($item in $items)
    {
      "id": "$item.pk.S",
      "title": #if($item.title.S == '') "$item.link.S" #else "$item.title.S" #end,
      "link": "$item.link.S",
      "tags": #if($item.tags.SS == '') [] #else $item.tags.SS #end,
      "upvotes": $item.upvotes.N,
      "referrer": "$item.referrer.S",
      "date": "$item.date.S"
    }#if($foreach.hasNext),#end
    #end
  ]
}
`;

const articleResponseTemplate = `
#set( $item = $input.path('$.Item') )
#if ( "$item" == "" )
#set( $context.responseOverride.status = 404 )
{
  "message": "article $input.params('articleId') not found"
}
#else
{
  "id": "$item.pk.S",
  "title": #if($item.title.S == '') "$item.link.S" #else "$item.title.S" #end,
  "link": "$item.link.S",
  "tags": #if($item.tags.SS == '') [] #else $item.tags.SS #end,
  "upvotes": $item.upvotes.N,
  "referrer": "$item.referrer.S",
  "date": "$item.date.S"
}
#end
`;

const postArticleResponseTemplate = `
#set( $context.responseOverride.header.Location = "/articles/$context.requestId" )
{
  "id": "$context.requestId",
  "date": "$context.requestTimeEpoch"
}
`;
